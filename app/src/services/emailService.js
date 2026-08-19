const nodemailer = require('nodemailer');

class EmailService {
  get transporter() {
    if (!this._transporter) {
      this._transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    }
    return this._transporter;
  }

  async sendWelcomeEmail({ to, username, password, name }) {
    const siteUrl = process.env.SITE_URL || 'http://localhost:8000';
    console.log(`[Email] Enviando email de bienvenida a ${to}...`);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <div style="background: #0f6b4f; color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 1.4rem;">🎉 ¡Bienvenido a Bot Menu!</h1>
        </div>
        <div style="background: #f8f9fa; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="font-size: 1rem; color: #333;">Hola <strong>${name || '!'}</strong>,</p>
          <p style="font-size: 0.95rem; color: #555; line-height: 1.6;">
            Gracias por suscribirte. Ya podés acceder al panel de administración de tu bot de WhatsApp
            con las siguientes credenciales:
          </p>

          <div style="background: white; border: 1px solid #d4ede3; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 12px 0; font-size: 0.8rem; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Tus credenciales</p>
            <p style="margin: 0 0 6px 0; font-size: 0.95rem; color: #333;">
              <strong>Usuario:</strong> <span style="font-family: monospace; background: #f0fdf4; padding: 2px 6px; border-radius: 4px;">${username}</span>
            </p>
            <p style="margin: 0; font-size: 0.95rem; color: #333;">
              <strong>Contraseña:</strong> <span style="font-family: monospace; background: #f0fdf4; padding: 2px 6px; border-radius: 4px;">${password}</span>
            </p>
          </div>

          <p style="font-size: 0.95rem; color: #555; line-height: 1.6;">
            Ingresá desde aquí: <a href="${siteUrl}/app/login" style="color: #0f6b4f; font-weight: 600;">${siteUrl}/app/login</a>
          </p>

          <p style="font-size: 0.95rem; color: #555; line-height: 1.6;">
            Una vez dentro, vinculá tu número de WhatsApp escaneando el código QR
            y configurá el menú de tu negocio.
          </p>

          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 0.8rem; color: #999; text-align: center;">
            Bot Menu — WhatsApp Business Automation<br>
            Ante cualquier duda, respondé este correo.
          </p>
        </div>
      </div>
    `;

    const info = await this.transporter.sendMail({
      from: `"Bot Menu" <${process.env.SMTP_USER}>`,
      to,
      subject: '🎉 Bienvenido a Bot Menu — Tus credenciales de acceso',
      html
    }).catch(err => {
      console.error(`[Email] Error enviando bienvenida a ${to}:`, err.message);
      throw err;
    });

    console.log(`[Email] Welcome email sent to ${to}: ${info.messageId}`);
    return info;
  }

  async sendSuspensionWarningEmail({ to, name, fechaVencimiento, fechaSuspension }) {
    const siteUrl = process.env.SITE_URL || 'http://localhost:8000';
    const fSusp = fechaSuspension ? new Date(fechaSuspension) : new Date();
    const fVto = fechaVencimiento ? new Date(fechaVencimiento) : new Date();
    const fechaSuspStr = `${String(fSusp.getDate()).padStart(2, '0')}/${String(fSusp.getMonth() + 1).padStart(2, '0')}/${fSusp.getFullYear()}`;
    const fechaVtoStr = `${String(fVto.getDate()).padStart(2, '0')}/${String(fVto.getMonth() + 1).padStart(2, '0')}/${fVto.getFullYear()}`;
    console.log(`[Email] Enviando aviso de suspensión a ${to} (suspensión ${fechaSuspStr})...`);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <div style="background: #b45309; color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 1.4rem;">⚠️ Aviso de vencimiento de suscripción</h1>
        </div>
        <div style="background: #f8f9fa; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="font-size: 1rem; color: #333;">Hola <strong>${name || '!'}</strong>,</p>
          <p style="font-size: 0.95rem; color: #555; line-height: 1.6;">
            Te recordamos que tu suscripción venció el día <strong>${fechaVtoStr}</strong>. Tu servicio
            sigue disponible por un período de gracia y se mantendrá activo hasta el día
            <strong>${fechaSuspStr}</strong>.
          </p>

          <div style="background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 12px 0; font-size: 0.85rem; font-weight: 700; color: #9a3412;">
              Si el pago no se acredita antes de esa fecha, tu servicio será suspendido y tu bot de WhatsApp dejará de responder.
            </p>
            <p style="margin: 0; font-size: 0.9rem; color: #7c2d12; line-height: 1.6;">
              Recordá que tu suscripción se debita <strong>automáticamente</strong> de tu cuenta de Mercado Pago
              todos los meses. Es posible que, justo en el momento del cobro, tu cuenta no tuviera fondos disponibles.
              En ese caso, el débito <strong>se seguirá intentando automáticamente</strong> hasta que se acredite.
              Apenas el pago se procese, tu servicio se reactiva solo, sin necesidad de que hagas nada.
            </p>
          </div>

          <p style="font-size: 0.9rem; color: #555; line-height: 1.6;">
            Si ya realizaste el pago o cargaste fondos en Mercado Pago, no es necesario que hagas nada más:
            el débito se completará en los próximos días.
          </p>

          <p style="font-size: 0.9rem; color: #555; line-height: 1.6;">
            Ante cualquier consulta, respondé este correo o escribinos por WhatsApp.
          </p>

          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 0.8rem; color: #999; text-align: center;">
            Bot Menu — WhatsApp Business Automation<br>
            ${siteUrl}
          </p>
        </div>
      </div>
    `;

    const info = await this.transporter.sendMail({
      from: `"Bot Menu" <${process.env.SMTP_USER}>`,
      to,
      bcc: process.env.CONTACT_EMAIL_TO || process.env.ADMIN_EMAIL || '',
      subject: '⚠️ Tu suscripción vence pronto — Bot Menu',
      html
    }).catch(err => {
      console.error(`[Email] Error enviando aviso de suspensión a ${to}:`, err.message);
      throw err;
    });

    console.log(`[Email] Suspension warning sent to ${to}: ${info.messageId}`);
    return info;
  }

  async sendPasswordResetEmail({ to, name, resetUrl }) {
    const siteUrl = process.env.SITE_URL || 'http://localhost:8000';
    console.log(`[Email] Enviando email de recuperación a ${to}...`);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <div style="background: #0f6b4f; color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 1.4rem;">Recuperar Contraseña</h1>
        </div>
        <div style="background: #f8f9fa; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="font-size: 1rem; color: #333;">Hola <strong>${name || ''}</strong>,</p>
          <p style="font-size: 0.95rem; color: #555; line-height: 1.6;">
            Recibimos una solicitud para restablecer tu contraseña. Hacé clic en el botón de abajo para crear una nueva:
          </p>

          <div style="text-align: center; margin: 28px 0;">
            <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background: #0f6b4f; color: white; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 1rem;">
              Restablecer contraseña
            </a>
          </div>

          <p style="font-size: 0.88rem; color: #888; line-height: 1.5;">
            Este link expira en 15 minutos. Si no solicitaste este cambio, podés ignorar este email.
          </p>

          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 0.8rem; color: #999; text-align: center;">
            Bot Menu — WhatsApp Business Automation
          </p>
        </div>
      </div>
    `;

    const info = await this.transporter.sendMail({
      from: `"Bot Menu" <${process.env.SMTP_USER}>`,
      to,
      subject: 'Restablecer tu contraseña — Bot Menu',
      html
    }).catch(err => {
      console.error(`[Email] Error enviando recuperación a ${to}:`, err.message);
      throw err;
    });

    console.log(`[Email] Password reset email sent to ${to}: ${info.messageId}`);
    return info;
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

  sendInvoiceEmail({ to, name, email, factura, monto, periodoDesde, periodoHasta, esRenovacion }) {
    const siteUrl = process.env.SITE_URL || 'http://localhost:8000';
    const cuit = process.env.AFIP_CUIT || '—';
    const isFirst = !esRenovacion;
    console.log(`[Email] Enviando factura ${isFirst ? 'INICIAL' : 'RENOVACION'} a ${to} (factura ${factura ? factura.cbteNro : '?'})...`);

    const f = factura || {};
    const cbteDesc = f.cbteTipo === 11 ? 'Factura C' : 'Comprobante';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <div style="background: #0f6b4f; color: white; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 1.4rem;">${isFirst ? '🧾 Tu factura de Bot Menu' : '🔁 Factura de renovación — Bot Menu'}</h1>
        </div>
        <div style="background: #f8f9fa; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="font-size: 1rem; color: #333;">Hola <strong>${name || '!'}</strong>,</p>
          <p style="font-size: 0.95rem; color: #555; line-height: 1.6;">
            ${isFirst
              ? 'Tu suscripción está activa. Te enviamos el comprobante fiscal correspondiente al primer período facturado.'
              : 'Se procesó el cobro mensual de tu suscripción. Te enviamos el comprobante fiscal del nuevo período.'
            }
          </p>

          <div style="background: white; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <p style="margin: 0 0 12px 0; font-size: 0.8rem; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">${cbteDesc} — Comprobante autorizado</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem; color: #333;">
              <tr>
                <td style="padding: 6px 0; color: #777;">Comprobante</td>
                <td style="padding: 6px 0; text-align: right; font-weight: 700;">N° ${f.ptoVta ? String(f.ptoVta).padStart(4, '0') : '—'} - ${String(f.cbteNro || '').padStart(8, '0')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">Fecha de emisión</td>
                <td style="padding: 6px 0; text-align: right;">${this.formatDate(f.fecha || new Date().toISOString())}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">Período facturado</td>
                <td style="padding: 6px 0; text-align: right;">${this.formatDate(periodoDesde)} al ${this.formatDate(periodoHasta)}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">CUIT emisor</td>
                <td style="padding: 6px 0; text-align: right;">${cuit}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">Punto de venta</td>
                <td style="padding: 6px 0; text-align: right;">${f.ptoVta || '—'}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">N° de comprobante</td>
                <td style="padding: 6px 0; text-align: right;">${String(f.cbteNro || '').padStart(8, '0')}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">CAE</td>
                <td style="padding: 6px 0; text-align: right; font-family: monospace; font-weight: 700;">${f.cae || '—'}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">Vencimiento CAE</td>
                <td style="padding: 6px 0; text-align: right;">${this.formatDate(f.caeFchVto)}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #777;">Medio de pago</td>
                <td style="padding: 6px 0; text-align: right;">Mercado Pago — Suscripción mensual</td>
              </tr>
            </table>
            <div style="margin-top: 16px; padding-top: 14px; border-top: 1px dashed #ccc; display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 0.95rem; font-weight: 700; color: #333;">Total período</span>
              <span style="font-size: 1.15rem; font-weight: 800; color: #0f6b4f;">${this.formatMoney(monto)}</span>
            </div>
          </div>

          <p style="font-size: 0.82rem; color: #777; line-height: 1.5;">
            Tus datos fiscales del próximo vencimiento: ${this.formatDate(this._vencimiento(periodoHasta))} ${email ? `· Emitida a nombre de ${name} ${email}` : ''}
          </p>

          <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
          <p style="font-size: 0.8rem; color: #999; text-align: center;">
            Bot Menu — WhatsApp Business Automation<br>
            ${siteUrl}
          </p>
        </div>
      </div>
    `;

    return this.transporter.sendMail({
      from: `"Bot Menu" <${process.env.SMTP_USER}>`,
      to,
      bcc: process.env.CONTACT_EMAIL_TO || process.env.ADMIN_EMAIL || '',
      subject: `${isFirst ? '🧾 Tu Factura C de Bot Menu' : '🔁 Factura C de renovación — Bot Menu'}`,
      html
    }).then(info => {
      console.log(`[Email] Invoice email sent to ${to}: ${info.messageId}`);
      return info;
    }).catch(err => {
      console.error(`[Email] Error enviando factura a ${to}:`, err.message);
      throw err;
    });
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
