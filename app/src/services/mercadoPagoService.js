const API_BASE = 'https://api.mercadopago.com';

class MercadoPagoService {
  get accessToken() {
    return process.env.MERCADOPAGO_ACCESS_TOKEN;
  }

  async createPreapproval({ reason, amount, payerEmail, backUrl }) {
    const body = {
      reason: reason || 'Suscripción Bot Menu',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: Number(amount),
        currency_id: 'ARS'
      },
      payer_email: payerEmail,
      back_url: backUrl,
      auto_return: 'approved',
      status: 'pending'
    };

    const res = await fetch(`${API_BASE}/preapproval`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[MercadoPago] Error creating preapproval:', err);
      throw new Error(`MercadoPago API error: ${res.status}`);
    }

    return res.json();
  }

  async getPreapproval(id) {
    const res = await fetch(`${API_BASE}/preapproval/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[MercadoPago] Error getting preapproval:', err);
      throw new Error(`MercadoPago API error: ${res.status}`);
    }

    return res.json();
  }
}

module.exports = new MercadoPagoService();
