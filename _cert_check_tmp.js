const fs = require('fs');
const { X509Certificate, createPrivateKey, createPublicKey } = require('crypto');

const pemCert = fs.readFileSync('./app/src/certs/saas-bot_42d9aa44d933064d.crt', 'utf8');
const pemKey = fs.readFileSync('./app/src/certs/privada.key', 'utf8');

try {
  const cert = new X509Certificate(pemCert);
  console.log('Subject:', cert.subject);
  console.log('Válido desde:', cert.validFrom, '| hasta:', cert.validTo);
  console.log('Expirado:', new Date(cert.validTo) < new Date());
  console.log('Certificación válida hoy:', new Date(cert.validFrom) <= new Date() && new Date() <= new Date(cert.validTo));
} catch (e) {
  console.log('ERROR parseando cert:', e.message);
}

try {
  const k = createPrivateKey(pemKey);
  console.log('KEY tipo:', k.asymmetricKeyType);
  const pubFromKey = createPublicKey(k).export({ type: 'spki', format: 'pem' });
  const cert = new X509Certificate(pemCert);
  const pubFromCert = createPublicKey(cert.publicKey).export({ type: 'spki', format: 'pem' });
  console.log('Key coincide con cert:', pubFromKey === pubFromCert);
} catch (e) {
  console.log('ERROR con key:', e.message);
  const lines = pemKey.trim().split(/\r?\n/);
  console.log('Longitud body key (base64):', lines.slice(1, -1).join('').length);
}
