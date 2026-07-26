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
    });

    console.log(`[Email] Welcome email sent to ${to}: ${info.messageId}`);
    return info;
  }

  async sendPasswordResetEmail({ to, name, resetUrl }) {
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
    });

    console.log(`[Email] Password reset email sent to ${to}: ${info.messageId}`);
    return info;
  }
}

module.exports = new EmailService();
