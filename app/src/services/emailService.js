const { Resend } = require('resend');

const SITE_URL = process.env.SITE_URL || 'http://localhost:8000';
const FROM_EMAIL = process.env.CONTACT_EMAIL_FROM || 'no-reply@wamenu.com.ar';
const ADMIN_EMAIL = process.env.CONTACT_EMAIL_TO || process.env.ADMIN_EMAIL || '';
const PHYSICAL_ADDRESS = 'Wamenu, Argentina';

const FOOTER = `
  <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0 16px;">
  <p style="font-size:0.78rem;color:#999;text-align:center;margin:0;">
    Bot Menu — WhatsApp Business Automation<br>
    ${PHYSICAL_ADDRESS}<br>
    <a href="${SITE_URL}/app/unsubscribe" style="color:#999;text-decoration:underline;">Darse de baja</a>
  </p>
`;

class EmailService {
  get client() {
    if (!this._client) {
      this._client = new Resend(process.env.RESEND_API_KEY);
    }
    return this._client;
  }

  async _send({ to, subject, html, bcc }) {
    console.log(`[Email] Sending "${subject}" to ${to}...`);
    const payload = {
      from: FROM_EMAIL,
      to,
      subject,
      html
    };
    if (bcc) payload.bcc = bcc;
    const result = await this.client.emails.send(payload);
    if (result.error) throw new Error(result.error.message);
    console.log(`[Email] Sent: ${result.data?.id}`);
    return result;
  }

  async sendWelcomeEmail({ to, username, password, name }) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:#0f6b4f;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:1.4rem;">¡Bienvenido a Bot Menu!</h1>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            Tu cuenta fue creada exitosamente. Estas son tus credenciales de acceso:
          </p>
          <div style="background:white;border:1px solid #d4ede3;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 12px;font-size:0.8rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Tus credenciales</p>
            <p style="margin:0 0 6px;font-size:0.95rem;color:#333;">
              <strong>Usuario:</strong> <span style="font-family:monospace;background:#f0fdf4;padding:2px 6px;border-radius:4px;">${username}</span>
            </p>
            <p style="margin:0;font-size:0.95rem;color:#333;">
              <strong>Contraseña:</strong> <span style="font-family:monospace;background:#f0fdf4;padding:2px 6px;border-radius:4px;">${password}</span>
            </p>
          </div>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            Ingresá desde aquí: <a href="${SITE_URL}/app/login" style="color:#0f6b4f;font-weight:600;">${SITE_URL}/app/login</a>
          </p>
          <p style="font-size:0.85rem;color:#888;line-height:1.5;">
            Recomendamos cambiar tu contraseña después del primer ingreso.
          </p>
          ${FOOTER}
        </div>
      </div>
    `;
    return this._send({ to, subject: 'Bienvenido a Bot Menu — Tus credenciales de acceso', html });
  }

  async sendSuspensionWarningEmail({ to, name, fechaVencimiento, fechaSuspension }) {
    const fSusp = fechaSuspension ? new Date(fechaSuspension) : new Date();
    const fVto = fechaVencimiento ? new Date(fechaVencimiento) : new Date();
    const fechaSuspStr = `${String(fSusp.getDate()).padStart(2, '0')}/${String(fSusp.getMonth() + 1).padStart(2, '0')}/${fSusp.getFullYear()}`;
    const fechaVtoStr = `${String(fVto.getDate()).padStart(2, '0')}/${String(fVto.getMonth() + 1).padStart(2, '0')}/${fVto.getFullYear()}`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:#b45309;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:1.4rem;">Aviso de vencimiento de suscripción</h1>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            Tu suscripción venció el día <strong>${fechaVtoStr}</strong>. Tu servicio
            sigue disponible por un período de gracia hasta el día <strong>${fechaSuspStr}</strong>.
          </p>
          <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="margin:0;font-size:0.9rem;color:#7c2d12;line-height:1.6;">
              Si el pago no se acredita antes de esa fecha, tu servicio será suspendido y tu bot de WhatsApp dejará de responder.
              El débito se seguirá intentando automáticamente hasta que se acredite.
            </p>
          </div>
          <p style="font-size:0.9rem;color:#555;line-height:1.6;">
            Ante cualquier consulta, respondé este correo o escribinos por WhatsApp.
          </p>
          ${FOOTER}
        </div>
      </div>
    `;
    return this._send({
      to,
      subject: 'Tu suscripción vence pronto — Bot Menu',
      html,
      bcc: ADMIN_EMAIL || undefined
    });
  }

  async sendTrialReminderEmail({ to, name, diasRestantes, trialEndDate }) {
    const fEnd = trialEndDate ? new Date(trialEndDate) : new Date();
    const fechaFinStr = `${String(fEnd.getDate()).padStart(2, '0')}/${String(fEnd.getMonth() + 1).padStart(2, '0')}/${fEnd.getFullYear()}`;

    const esUltimoDia = diasRestantes <= 0;
    const colorFondo = esUltimoDia ? '#dc2626' : '#b45309';
    const titulo = esUltimoDia
      ? 'Tu prueba gratuita terminó'
      : `Tu prueba termina en ${diasRestantes} día${diasRestantes !== 1 ? 's' : ''}`;
    const texto = esUltimoDia
      ? 'Tu período de prueba de 30 días finalizó. Para seguir usando Bot Menu, activá tu plan mensual.'
      : `Tu período de prueba gratuito vence el <strong>${fechaFinStr}</strong>. Quedan <strong>${diasRestantes} día${diasRestantes !== 1 ? 's' : ''}</strong>.`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:${colorFondo};color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:1.4rem;">${titulo}</h1>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">${texto}</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${SITE_URL}/suscripcion" style="display:inline-block;padding:14px 32px;background:#0f6b4f;color:white;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Activar mi plan</a>
          </div>
          <p style="font-size:0.88rem;color:#888;line-height:1.5;">
            El plan mensual tiene un costo de $${this.formatMoney(process.env.PRECIO_ESTANDAR || 28000)}/mes. Podés cancelar en cualquier momento.
          </p>
          ${FOOTER}
        </div>
      </div>
    `;
    return this._send({ to, subject: titulo, html });
  }

  async sendTrialExpiredEmail({ to, name }) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:#dc2626;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:1.4rem;">Tu prueba gratuita terminó</h1>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            Tu período de prueba de 30 días finalizó y tu bot de WhatsApp se pausó automáticamente.
          </p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            Para volver a usar Bot Menu, activá tu plan mensual haciendo clic en el botón de abajo.
          </p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${SITE_URL}/suscripcion" style="display:inline-block;padding:14px 32px;background:#0f6b4f;color:white;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Activar mi plan</a>
          </div>
          <p style="font-size:0.88rem;color:#888;line-height:1.5;">
            Mientras tanto, podés seguir ingresando al panel para revisar tu configuración.
          </p>
          ${FOOTER}
        </div>
      </div>
    `;
    return this._send({ to, subject: 'Tu prueba gratuita de Bot Menu terminó', html });
  }

  async sendPasswordResetEmail({ to, name, resetUrl }) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:#0f6b4f;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:1.4rem;">Recuperar Contraseña</h1>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            Recibimos una solicitud para restablecer tu contraseña. Hacé clic en el botón de abajo:
          </p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#0f6b4f;color:white;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">Restablecer contraseña</a>
          </div>
          <p style="font-size:0.88rem;color:#888;line-height:1.5;">
            Este link expira en 15 minutos. Si no solicitaste este cambio, podés ignorar este email.
          </p>
          ${FOOTER}
        </div>
      </div>
    `;
    return this._send({ to, subject: 'Restablecer tu contraseña — Bot Menu', html });
  }

  async sendVerificationEmail({ to, name, token }) {
    const verifyUrl = `${SITE_URL}/api/verify-email?token=${token}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:#0f6b4f;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:22px;">Verificá tu email</h1>
        </div>
        <div style="background:#f9f9f9;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">Para completar tu registro, hacé clic en el botón:</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${verifyUrl}" style="background:#0f6b4f;color:white;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block;">Verificar mi email</a>
          </div>
          <p style="font-size:0.88rem;color:#888;">Si no creaste esta cuenta, podés ignorar este mensaje.</p>
          ${FOOTER}
        </div>
      </div>
    `;
    return this._send({ to, subject: 'Verificá tu email — Bot Menu', html });
  }

  sendInvoiceEmail({ to, name, email, factura, monto, periodoDesde, periodoHasta, esRenovacion }) {
    const cuit = process.env.AFIP_CUIT || '—';
    const isFirst = !esRenovacion;
    console.log(`[Email] Enviando factura ${isFirst ? 'INICIAL' : 'RENOVACION'} a ${to} (factura ${factura ? factura.cbteNro : '?'})...`);

    const f = factura || {};
    const cbteDesc = f.cbteTipo === 11 ? 'Factura C' : 'Comprobante';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <div style="background:#0f6b4f;color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="margin:0;font-size:1.4rem;">${isFirst ? 'Tu factura de Bot Menu' : 'Factura de renovación — Bot Menu'}</h1>
        </div>
        <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0;border-top:none;">
          <p style="font-size:1rem;color:#333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size:0.95rem;color:#555;line-height:1.6;">
            ${isFirst
              ? 'Tu suscripción está activa. Te enviamos el comprobante fiscal correspondiente al primer período facturado.'
              : 'Se procesó el cobro mensual de tu suscripción. Te enviamos el comprobante fiscal del nuevo período.'
            }
          </p>
          <div style="background:white;border:1px solid #ddd;border-radius:8px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 12px;font-size:0.8rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;">${cbteDesc} — Comprobante autorizado</p>
            <table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#333;">
              <tr><td style="padding:6px 0;color:#777;">Comprobante</td><td style="padding:6px 0;text-align:right;font-weight:700;">N° ${f.ptoVta ? String(f.ptoVta).padStart(4, '0') : '—'} - ${String(f.cbteNro || '').padStart(8, '0')}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">Fecha de emisión</td><td style="padding:6px 0;text-align:right;">${this.formatDate(f.fecha || new Date().toISOString())}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">Período facturado</td><td style="padding:6px 0;text-align:right;">${this.formatDate(periodoDesde)} al ${this.formatDate(periodoHasta)}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">CUIT emisor</td><td style="padding:6px 0;text-align:right;">${cuit}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">Punto de venta</td><td style="padding:6px 0;text-align:right;">${f.ptoVta || '—'}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">N° de comprobante</td><td style="padding:6px 0;text-align:right;">${String(f.cbteNro || '').padStart(8, '0')}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">CAE</td><td style="padding:6px 0;text-align:right;font-family:monospace;font-weight:700;">${f.cae || '—'}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">Vencimiento CAE</td><td style="padding:6px 0;text-align:right;">${this.formatDate(f.caeFchVto)}</td></tr>
              <tr><td style="padding:6px 0;color:#777;">Medio de pago</td><td style="padding:6px 0;text-align:right;">Mercado Pago — Suscripción mensual</td></tr>
            </table>
            <div style="margin-top:16px;padding-top:14px;border-top:1px dashed #ccc;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:0.95rem;font-weight:700;color:#333;">Total período</span>
              <span style="font-size:1.15rem;font-weight:800;color:#0f6b4f;">${this.formatMoney(monto)}</span>
            </div>
          </div>
          <p style="font-size:0.82rem;color:#777;line-height:1.5;">
            Tus datos fiscales del próximo vencimiento: ${this.formatDate(this._vencimiento(periodoHasta))} ${email ? `· Emitida a nombre de ${name} ${email}` : ''}
          </p>
          ${FOOTER}
        </div>
      </div>
    `;

    return this._send({
      to,
      subject: `${isFirst ? 'Tu Factura C de Bot Menu' : 'Factura C de renovación — Bot Menu'}`,
      html,
      bcc: ADMIN_EMAIL || undefined
    });
  }

  formatMoney(n) {
    return '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  formatDate(iso) {
    if (!iso) return '';
    const s = String(iso);
    if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return s;
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  _vencimiento(periodoHasta) {
    if (!periodoHasta) return new Date();
    const s = String(periodoHasta);
    if (/^\d{8}$/.test(s)) {
      const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
      d.setMonth(d.getMonth() + 1);
      return d;
    }
    return new Date();
  }
}

module.exports = new EmailService();
