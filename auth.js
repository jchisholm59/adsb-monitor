// Guest / admin access. With ADMIN_PASSWORD set, anyone can look but only the owner can change anything:
// alert settings, watched flights, test alerts (and the alert history, which shows what is being watched).
// Signing in trades the password for a token (an HMAC of the password, so changing the password signs everyone
// out); the card keeps it (HA user data or the browser) and sends it as `Authorization: Bearer <token>`.
// No ADMIN_PASSWORD: no sign-in, everything open, as before. `trusted`: addresses always treated as the owner (the HA
// add-on passes Home Assistant's ingress proxy, 172.30.32.2, whose users have already signed in to HA).
const crypto = require('crypto');

module.exports = function auth(password, service, trusted = '') {
  const token = password ? crypto.createHmac('sha256', password).update(`${service} admin`).digest('hex') : '';
  const fails = new Map(); // ip -> {n, t}: 5 wrong passwords lock that address out for 15 minutes
  const LOCK_MS = 15 * 60_000;

  const same = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const ip = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const trust = new Set(trusted.split(/[\s,]+/).filter(Boolean));
  const isAdmin = (req) => {
    if (!password || trust.has(ip(req))) return true;
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    return !!m && same(m[1], token);
  };

  return {
    required: !!password,
    isAdmin,
    status: (req) => ({ required: !!password, admin: isAdmin(req) }),
    // POST /api/login {password} -> {token}; a wrong one waits a second, and too many lock the address out.
    async login(req, given) {
      const f = fails.get(ip(req));
      if (f && f.n >= 5 && Date.now() - f.t < LOCK_MS) return { status: 429, body: { error: 'too many tries, wait 15 minutes' } };
      if (password && typeof given === 'string' && same(crypto.createHash('sha256').update(given).digest('hex'), crypto.createHash('sha256').update(password).digest('hex'))) {
        fails.delete(ip(req));
        return { status: 200, body: { token } };
      }
      fails.set(ip(req), { n: (f && Date.now() - f.t < LOCK_MS ? f.n : 0) + 1, t: Date.now() });
      await new Promise((r) => setTimeout(r, 1000));
      return { status: 401, body: { error: password ? 'wrong password' : 'no ADMIN_PASSWORD set' } };
    },
  };
};
