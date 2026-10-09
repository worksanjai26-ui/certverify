// In-memory stand-in for the subset of the Firestore Admin API that FirestoreStore uses.
// It enforces the Firestore rules that matter for correctness, so tests fail where real Firestore would:
//   - documents over 1 MiB are rejected (scans must be chunked)
//   - create() fails if the document exists; update() fails if it doesn't
//   - in a transaction, all reads must happen before any write
//   - where(f, '==', null) matches only fields that exist and are null
//   - range filters / orderBy combined with a filter on another field need a composite index -> rejected
//   - undefined fields are dropped (the app enables ignoreUndefinedProperties)

const MAX_DOC_BYTES = 1_048_487;

class Increment {
  constructor(n) {
    this.n = n;
  }
}
export const increment = (n) => new Increment(n);

const clone = (v) => {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object' && !(v instanceof Increment)) {
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, clone(x)]));
  }
  return v;
};

const sizeOf = (v) => {
  if (v === null || v === undefined) return 1;
  if (Buffer.isBuffer(v)) return v.length;
  if (typeof v === 'string') return Buffer.byteLength(v) + 1;
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  if (Array.isArray(v)) return v.reduce((s, x) => s + sizeOf(x), 0);
  return Object.entries(v).reduce((s, [k, x]) => s + k.length + 1 + sizeOf(x), 0);
};

function failed(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

class DocSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = value;
  }
  data() {
    return this._value === undefined ? undefined : clone(this._value);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
}

class Query {
  constructor(fs, path, spec = { filters: [], order: null, limit: null, select: null }) {
    this.fs = fs;
    this.path = path;
    this.spec = spec;
  }
  _with(change) {
    return new Query(this.fs, this.path, { ...this.spec, ...change });
  }
  where(field, op, value) {
    return this._with({ filters: [...this.spec.filters, { field, op, value }] });
  }
  orderBy(field, dir = 'asc') {
    return this._with({ order: { field, dir } });
  }
  limit(n) {
    return this._with({ limit: n });
  }
  select(...fields) {
    return this._with({ select: fields });
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this._run(true).length }) }) };
  }
  async get() {
    return new QuerySnapshot(this._run());
  }
  _checkIndexes() {
    const { filters, order } = this.spec;
    const range = filters.filter((f) => f.op !== '==');
    const rangeFields = new Set(range.map((f) => f.field));
    if (rangeFields.size > 1) throw failed('FAILED_PRECONDITION', 'range filters on several fields need a composite index');
    const sortField = order?.field ?? [...rangeFields][0];
    if (order && rangeFields.size && !rangeFields.has(order.field)) {
      throw failed('INVALID_ARGUMENT', 'the first orderBy must be on the range-filtered field');
    }
    if (sortField && filters.some((f) => f.op === '==' && f.field !== sortField)) {
      throw failed('FAILED_PRECONDITION', `query on ${this.path} needs a composite index (equality + range/order)`);
    }
  }
  _run(forCount = false) {
    this._checkIndexes();
    const { filters, order, limit, select } = this.spec;
    let docs = [...this.fs.docs.entries()]
      .filter(([p]) => p.slice(0, p.lastIndexOf('/')) === this.path)
      .map(([p, v]) => ({ ref: new DocRef(this.fs, p), value: v }));
    for (const { field, op, value } of filters) {
      docs = docs.filter(({ value: d }) => {
        if (!(field in d)) return false;
        const x = d[field];
        if (op === '==') return x === value;
        if (x === null) return false;
        return op === '>' ? x > value : op === '>=' ? x >= value : op === '<' ? x < value : x <= value;
      });
    }
    if (order) {
      docs = docs.filter(({ value: d }) => order.field in d);
      docs.sort((a, b) => {
        const [x, y] = [a.value[order.field], b.value[order.field]];
        return (x < y ? -1 : x > y ? 1 : 0) * (order.dir === 'desc' ? -1 : 1);
      });
    }
    if (limit != null) docs = docs.slice(0, limit);
    if (forCount) return docs;
    return docs.map(({ ref, value }) => {
      const v = select ? Object.fromEntries(select.filter((f) => f in value).map((f) => [f, value[f]])) : value;
      return new DocSnapshot(ref, v);
    });
  }
}

class CollectionRef extends Query {
  constructor(fs, path) {
    super(fs, path);
  }
  doc(id = Math.random().toString(36).slice(2, 12)) {
    return new DocRef(this.fs, `${this.path}/${id}`);
  }
}

class DocRef {
  constructor(fs, path) {
    this.fs = fs;
    this.path = path;
    this.id = path.slice(path.lastIndexOf('/') + 1);
  }
  collection(name) {
    return new CollectionRef(this.fs, `${this.path}/${name}`);
  }
  async get() {
    return new DocSnapshot(this, this.fs.docs.get(this.path));
  }
  async set(data) {
    this.fs._write(this.path, clone(data), 'set');
  }
  async create(data) {
    this.fs._write(this.path, clone(data), 'create');
  }
  async update(data) {
    this.fs._write(this.path, clone(data), 'update');
  }
  async delete() {
    this.fs.docs.delete(this.path);
  }
}

class Transaction {
  constructor(fs) {
    this.fs = fs;
    this.writes = [];
  }
  async get(target) {
    if (this.writes.length) throw failed('INVALID_ARGUMENT', 'transactions require all reads before all writes');
    return target.get();
  }
  set(ref, data) {
    this.writes.push([ref.path, clone(data), 'set']);
  }
  create(ref, data) {
    this.writes.push([ref.path, clone(data), 'create']);
  }
  update(ref, data) {
    this.writes.push([ref.path, clone(data), 'update']);
  }
}

export class FakeFirestore {
  docs = new Map();
  #queue = Promise.resolve();

  collection(path) {
    return new CollectionRef(this, path);
  }

  _write(path, data, mode) {
    const existing = this.docs.get(path);
    if (mode === 'create' && existing) throw failed('ALREADY_EXISTS', path);
    if (mode === 'update' && !existing) throw failed('NOT_FOUND', path);
    const base = mode === 'update' ? { ...existing } : {};
    for (const [k, v] of Object.entries(data)) base[k] = v instanceof Increment ? (base[k] ?? 0) + v.n : v;
    if (sizeOf(base) > MAX_DOC_BYTES) throw failed('INVALID_ARGUMENT', `document ${path} exceeds 1 MiB`);
    this.docs.set(path, base);
  }

  // Transactions run one at a time and apply their writes all-or-nothing.
  runTransaction(fn) {
    const run = this.#queue.then(async () => {
      const tx = new Transaction(this);
      const result = await fn(tx);
      const snapshot = new Map(this.docs);
      try {
        for (const [path, data, mode] of tx.writes) this._write(path, data, mode);
      } catch (e) {
        this.docs = snapshot;
        throw e;
      }
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}
