// Storage on Firebase Cloud Firestore. Same methods and row shapes as SqlStore.
//
// Collections:
//   users/{email}  sessions/{tokenHash}  settings/{key}  counters/{name}
//   certificates/{id}  certificates/{id}/files/{original|stamped}-{n}   (scans split into <1 MB chunks)
//   file_hashes/{sha256} -> { cert_id, kind }                            (lookup + duplicate protection)
//   verifications/{n}  alerts/{n}  audit_events/{n}                      (numbered via counters, in transactions)
//
// Every query uses at most one range/order field or equality filters only, so no composite
// indexes have to be created in the Firebase console. Searching and filtering of lists happens
// in memory, which is fine at a college's scale.

const VERDICTS = ['verified', 'tampered', 'invalid_signature', 'revoked', 'review', 'not_found'];
const CHUNK_BYTES = 900 * 1024; // Firestore documents are limited to 1 MiB
const SCAN_LIMIT = 2000;

const pad = (n) => String(n).padStart(12, '0');
const data = (snap) => (snap.exists ? snap.data() : undefined);
const rows = (qs) => qs.docs.map((d) => d.data());
const byIdDesc = (a, b) => b.id - a.id;
const countOf = async (query) => (await query.count().get()).data().count;
const certRow = (c) => {
  if (!c) return c;
  const { search, verification_count, ...row } = c;
  return row;
};

export class FirestoreStore {
  kind = 'firestore';

  // `firestore` is a Firestore instance (firebase-admin or the test fake); `increment` is FieldValue.increment.
  constructor(firestore, { increment, close } = {}) {
    this.fs = firestore;
    this.increment = increment;
    this.closeFn = close;
  }

  close() {
    this.closeFn?.();
  }

  col(name) {
    return this.fs.collection(name);
  }

  // Atomic sequence numbers shared by every server instance.
  nextSeq(tx, name) {
    return tx.get(this.col('counters').doc(name)).then((snap) => {
      const value = (data(snap)?.value ?? 0) + 1;
      tx.set(this.col('counters').doc(name), { value });
      return value;
    });
  }

  async addNumbered(collection, record) {
    return this.fs.runTransaction(async (tx) => {
      const id = await this.nextSeq(tx, collection);
      tx.create(this.col(collection).doc(pad(id)), { ...record, id });
      return id;
    });
  }

  // ---- users & sessions ----
  async getUserByEmail(email) {
    const u = data(await this.col('users').doc(email).get());
    return u && { ...u, id: u.email };
  }

  async ensureAdmin({ email, name, passwordHash }) {
    return this.fs.runTransaction(async (tx) => {
      const any = await tx.get(this.col('users').limit(1));
      if (!any.empty) return false;
      tx.create(this.col('users').doc(email), { email, name, password_hash: passwordHash, created_at: new Date().toISOString() });
      return true;
    });
  }

  async createSession(tokenHash, user, expiresAt) {
    const expired = await this.col('sessions').where('expires_at', '<', new Date().toISOString()).limit(50).get();
    await Promise.all(expired.docs.map((d) => d.ref.delete()));
    await this.col('sessions').doc(tokenHash).set({ user_email: user.email, expires_at: expiresAt });
  }

  async getSession(tokenHash) {
    const s = data(await this.col('sessions').doc(tokenHash).get());
    if (!s) return undefined;
    const u = await this.getUserByEmail(s.user_email);
    return u && { id: u.email, email: u.email, name: u.name, expires_at: s.expires_at };
  }

  async deleteSession(tokenHash) {
    await this.col('sessions').doc(tokenHash).delete();
  }

  // ---- settings ----
  async getOrInitSetting(key, initialValue) {
    return this.fs.runTransaction(async (tx) => {
      const ref = this.col('settings').doc(key);
      const existing = data(await tx.get(ref));
      if (existing) return existing.value;
      tx.create(ref, { value: initialValue });
      return initialValue;
    });
  }

  // ---- certificates ----
  async nextCertificateId(prefix) {
    const n = await this.fs.runTransaction((tx) => this.nextSeq(tx, `cert:${prefix}`));
    return `${prefix}${String(n).padStart(3, '0')}`;
  }

  async insertCertificate(c, original, stamped) {
    const certRef = this.col('certificates').doc(c.id);
    await this.fs.runTransaction(async (tx) => {
      const [dupFile, dupId] = await Promise.all([tx.get(this.col('file_hashes').doc(c.document_hash)), tx.get(certRef)]);
      if (dupFile.exists) throw Object.assign(new Error('duplicate file'), { code: 'duplicate-file' });
      if (dupId.exists) throw Object.assign(new Error('duplicate id'), { code: 'duplicate-id' });
      tx.create(certRef, {
        ...c,
        status: 'active',
        revoked_at: null,
        revoke_reason: null,
        revoked_by: null,
        verification_count: 0,
        search: `${c.id} ${c.roll_no} ${c.student_name}`.toLowerCase(),
      });
      tx.create(this.col('file_hashes').doc(c.document_hash), { cert_id: c.id, kind: 'original' });
      tx.set(this.col('file_hashes').doc(c.stamped_hash), { cert_id: c.id, kind: 'stamped' });
    });
    // Files go into chunk documents after the record exists (a transaction can't hold 2 × 4 MB).
    const writes = [];
    for (const [kind, buf] of [
      ['original', original],
      ['stamped', stamped],
    ]) {
      for (let i = 0, n = 0; i < buf.length || n === 0; i += CHUNK_BYTES, n++) {
        writes.push(certRef.collection('files').doc(`${kind}-${n}`).set({ kind, index: n, data: Buffer.from(buf.subarray(i, i + CHUNK_BYTES)) }));
      }
    }
    await Promise.all(writes);
  }

  async getCertificate(id) {
    return certRow(data(await this.col('certificates').doc(id).get()));
  }

  async findCertificateByFileHash(hash) {
    const link = data(await this.col('file_hashes').doc(hash).get());
    return link ? this.getCertificate(link.cert_id) : undefined;
  }

  async getCertificateFile(id, version) {
    const cert = await this.getCertificate(id);
    if (!cert) return undefined;
    const kind = version === 'original' ? 'original' : 'stamped';
    const chunks = rows(await this.col('certificates').doc(id).collection('files').where('kind', '==', kind).get());
    chunks.sort((a, b) => a.index - b.index);
    return { id, document_type: cert.document_type, file: Buffer.concat(chunks.map((c) => Buffer.from(c.data))) };
  }

  async listCertificates({ q = '', status = null } = {}) {
    const needle = q.toLowerCase();
    return rows(await this.col('certificates').get())
      .filter((c) => (!needle || c.search.includes(needle)) && (!status || c.status === status))
      .sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1))
      .map((c) => ({ ...certRow(c), verification_count: c.verification_count ?? 0 }));
  }

  async revokeCertificate(id, { at, reason, by }) {
    return this.fs.runTransaction(async (tx) => {
      const ref = this.col('certificates').doc(id);
      const c = data(await tx.get(ref));
      if (!c) return 'missing';
      if (c.status === 'revoked') return 'already';
      tx.update(ref, { status: 'revoked', revoked_at: at, revoke_reason: reason, revoked_by: by });
      return 'ok';
    });
  }

  async updateCertificatePayload(id, payload) {
    await this.col('certificates').doc(id).update({ payload });
  }

  // ---- verifications ----
  async addVerification(v) {
    const id = await this.addNumbered('verifications', { ...v, malpractice: v.malpractice ? 1 : 0 });
    if (v.cert_id) {
      await this.col('certificates')
        .doc(v.cert_id)
        .update({ verification_count: this.increment(1) })
        .catch(() => {}); // not every checked ID exists
    }
    return id;
  }

  async listVerifications({ after = 0, verdict = null, certId = null, q = null, limit = 200 } = {}) {
    const base = certId
      ? rows(await this.col('verifications').where('cert_id', '==', certId).get())
      : rows(await this.col('verifications').where('id', '>', after).orderBy('id', 'desc').limit(SCAN_LIMIT).get());
    const needle = q?.toLowerCase();
    return base
      .filter(
        (v) =>
          v.id > after &&
          (!verdict || v.verdict === verdict) &&
          (!needle || [v.verifier_name, v.verifier_org, v.cert_id].some((f) => f?.toLowerCase().includes(needle))),
      )
      .sort(byIdDesc)
      .slice(0, limit);
  }

  async verificationCounts(after = 0) {
    const [newCount, latest] = await Promise.all([
      countOf(this.col('verifications').where('id', '>', after)),
      this.col('verifications').orderBy('id', 'desc').limit(1).get(),
    ]);
    return { newCount, latestId: latest.empty ? 0 : latest.docs[0].data().id };
  }

  // ---- alerts ----
  addAlert(a) {
    return this.addNumbered('alerts', { ...a, acknowledged_at: null, acknowledged_by: null, note: null });
  }

  async listAlerts({ status = 'all', certId = null, limit = 200 } = {}) {
    const base = certId
      ? rows(await this.col('alerts').where('cert_id', '==', certId).get())
      : rows(await this.col('alerts').orderBy('id', 'desc').limit(SCAN_LIMIT).get());
    return base
      .filter((a) => status === 'all' || (status === 'open' ? a.acknowledged_at === null : a.acknowledged_at !== null))
      .sort(byIdDesc)
      .slice(0, limit);
  }

  async alertCounts() {
    const alerts = this.col('alerts');
    const [open, openHigh, latest] = await Promise.all([
      countOf(alerts.where('acknowledged_at', '==', null)),
      countOf(alerts.where('acknowledged_at', '==', null).where('severity', '==', 'high')),
      alerts.orderBy('id', 'desc').limit(1).get(),
    ]);
    return { open, openHigh, latestId: latest.empty ? 0 : latest.docs[0].data().id };
  }

  async ackAlert(id, { at, by, note }) {
    return this.fs.runTransaction(async (tx) => {
      const ref = this.col('alerts').doc(pad(id));
      const a = data(await tx.get(ref));
      if (!a || a.acknowledged_at !== null) return false;
      tx.update(ref, { acknowledged_at: at, acknowledged_by: by, note });
      return true;
    });
  }

  // ---- registrar audit log ----
  async addAudit({ action, certId = null, detail = null, actor = null, ip = null }) {
    await this.addNumbered('audit_events', { at: new Date().toISOString(), action, cert_id: certId, detail, actor, ip });
  }

  async listAudit({ action = null, certId = null, limit = 200 } = {}) {
    const base = certId
      ? rows(await this.col('audit_events').where('cert_id', '==', certId).get())
      : rows(await this.col('audit_events').orderBy('id', 'desc').limit(SCAN_LIMIT).get());
    return base.filter((e) => !action || e.action === action).sort(byIdDesc).slice(0, limit);
  }

  // ---- dashboard ----
  async stats(startOfDayIso) {
    const certs = this.col('certificates');
    const ver = this.col('verifications');
    const alerts = this.col('alerts');
    const [total, active, revoked, vTotal, vToday, orgs, verdictCounts, aTotal, aOpen, aOpenHigh] = await Promise.all([
      countOf(certs),
      countOf(certs.where('status', '==', 'active')),
      countOf(certs.where('status', '==', 'revoked')),
      countOf(ver),
      countOf(ver.where('at', '>=', startOfDayIso)),
      ver.select('verifier_org').get(),
      Promise.all(VERDICTS.map(async (verdict) => ({ verdict, n: await countOf(ver.where('verdict', '==', verdict)) }))),
      countOf(alerts),
      countOf(alerts.where('acknowledged_at', '==', null)),
      countOf(alerts.where('acknowledged_at', '==', null).where('severity', '==', 'high')),
    ]);
    return {
      certificates: { total, active, revoked },
      verifications: {
        total: vTotal,
        today: vToday,
        organisations: new Set(orgs.docs.map((d) => String(d.data().verifier_org ?? '').toLowerCase())).size,
      },
      verdicts: verdictCounts.filter((v) => v.n > 0).sort((a, b) => b.n - a.n),
      alerts: { total: aTotal, open: aOpen, openHigh: aOpenHigh },
    };
  }
}
