const { google } = require('googleapis');
const GoogleAuthBase = require('./googleAuthBase');

const TZ = 'America/Argentina/Buenos_Aires';
// Argentina usa UTC-3 fijo (sin DST desde 2009), por lo que el offset es seguro.
const OFFSET_MS = -3 * 60 * 60 * 1000;

/**
 * GoogleCalendarService: integración con Google Calendar API (v3).
 * Reutiliza el token OAuth global (igual que Sheets/Drive).
 * Todas las fechas se envían en ISO 8601 con zona America/Argentina/Buenos_Aires (-03:00).
 */
class GoogleCalendarService extends GoogleAuthBase {
    get calendar() {
        return google.calendar({ version: 'v3', auth: this.getAuthClient() });
    }

    // Convierte un instante a "reloj de pared" de Argentina (UTC fields == hora local AR)
    _argLocal(d) {
        return new Date(d.getTime() + OFFSET_MS);
    }

    _pad(n) {
        return String(n).padStart(2, '0');
    }

    // Construye un instante a partir de fecha 'YYYY-MM-DD' y hora local AR 'HH:MM'
    _toDate(dateStr, hh, mm) {
        return new Date(`${dateStr}T${this._pad(hh)}:${this._pad(mm)}:00${this._toOffsetString()}`);
    }

    _toOffsetString() {
        return '-03:00';
    }

    _toISO(d) {
        return d.toISOString();
    }

    // Devuelve el día de la semana (0=Domingo) para una fecha en Argentina
    _dowOf(dateStr) {
        return this._argLocal(new Date(`${dateStr}T12:00:00${this._toOffsetString()}`)).getUTCDay();
    }

    // Convierte un instante (Date) a minutos desde medianoche local AR
    _minutesOfDay(d) {
        const l = this._argLocal(d);
        return l.getUTCHours() * 60 + l.getUTCMinutes();
    }

    /**
     * Consulta disponibilidad y devuelve los slots libres (mantiene compatibilidad).
     */
    async consultarDisponibilidad(params) {
        const result = await this._consultarCompleto(params);
        return result.slots;
    }

    /**
     * Consulta disponibilidad y devuelve tanto los libres como los ocupados.
     * @returns {Promise<{slots:Array, ocupados:Array}>}
     */
    async consultarDisponibilidadConOcupados(params) {
        return this._consultarCompleto(params);
    }

    async _consultarCompleto({ calendarId, fecha, duracionMin = 30, businessHours = {}, minNoticeHours = 0 }) {
        if (!calendarId) throw new Error('calendar_id no configurado');

        const dayStart = this._toDate(fecha, 0, 0);
        const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

        const busyRanges = [];
        try {
            const res = await this.calendar.freebusy.query({
                requestBody: {
                    timeMin: this._toISO(dayStart),
                    timeMax: this._toISO(dayEnd),
                    timeZone: TZ,
                    items: [{ id: calendarId }]
                }
            });
            const busy = (res.data.calendars && res.data.calendars[calendarId] && res.data.calendars[calendarId].busy) || [];
            for (const b of busy) {
                const start = new Date(b.start);
                const end = new Date(b.end);
                busyRanges.push([this._minutesOfDay(start), this._minutesOfDay(end)]);
            }
        } catch (err) {
            console.error('[Calendar] Error en freebusy.query:', err.message);
            throw new Error('No se pudo consultar la disponibilidad del calendario');
        }

        const dow = this._dowOf(fecha);
        const ranges = businessHours[String(dow)] || [];
        const now = Date.now();
        const slots = [];
        const ocupados = [];

        for (const range of ranges) {
            if (!range || !range.desde || !range.hasta) continue;
            const [h1, m1] = String(range.desde).split(':').map(Number);
            const [h2, m2] = String(range.hasta).split(':').map(Number);
            if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) continue;

            let startMin = h1 * 60 + m1;
            let endMin = h2 * 60 + m2;
            if (endMin <= startMin) continue;

            for (let s = startMin; s + duracionMin <= endMin; s += duracionMin) {
                const e = s + duracionMin;
                const startISO = this._toISO(this._toDate(fecha, Math.floor(s / 60), s % 60));
                const endISO = this._toISO(this._toDate(fecha, Math.floor(e / 60), e % 60));

                const startTime = new Date(startISO).getTime();
                // Horarios que ya comenzaron hoy no se ofrecen
                if (startTime < now) continue;
                // Salto mínimo de reserva configurado
                if (minNoticeHours > 0 && startTime < now + minNoticeHours * 3600 * 1000) continue;

                const slotEntry = {
                    startISO,
                    endISO,
                    label: `${this._pad(Math.floor(s / 60))}:${this._pad(s % 60)}`
                };

                const overlap = busyRanges.some(([bs, be]) => s < be && bs < e);
                if (overlap) {
                    ocupados.push(slotEntry);
                    continue;
                }

                slots.push(slotEntry);
            }
        }

        return { slots, ocupados };
    }

    /**
     * Inserta un evento (turno) en Google Calendar.
     * @param {Object} params
     * @returns {Promise<Object>} evento creado
     */
    async agendarTurno({ calendarId, summary, description = '', fechaInicioISO, fechaFinISO }) {
        if (!calendarId) throw new Error('calendar_id no configurado');
        try {
            const res = await this.calendar.events.insert({
                calendarId,
                requestBody: {
                    summary,
                    description,
                    start: { dateTime: fechaInicioISO, timeZone: TZ },
                    end: { dateTime: fechaFinISO, timeZone: TZ }
                }
            });
            return res.data;
        } catch (err) {
            console.error('[Calendar] Error al agendar turno:', err.message);
            throw new Error('No se pudo agendar el turno en Google Calendar');
        }
    }

    /**
     * Modifica un evento existente (patch).
     */
    async editarTurno({ calendarId, eventId, fechaInicioISO, fechaFinISO }) {
        if (!calendarId || !eventId) throw new Error('calendar_id/eventId requeridos');
        try {
            const body = {};
            if (fechaInicioISO) body.start = { dateTime: fechaInicioISO, timeZone: TZ };
            if (fechaFinISO) body.end = { dateTime: fechaFinISO, timeZone: TZ };
            const res = await this.calendar.events.patch({ calendarId, eventId, requestBody: body });
            return res.data;
        } catch (err) {
            console.error('[Calendar] Error al editar turno:', err.message);
            throw new Error('No se pudo modificar el turno');
        }
    }

    /**
     * Elimina un evento del calendario.
     */
    async cancelarTurno({ calendarId, eventId }) {
        if (!calendarId || !eventId) throw new Error('calendar_id/eventId requeridos');
        try {
            await this.calendar.events.delete({ calendarId, eventId });
            return true;
        } catch (err) {
            console.error('[Calendar] Error al cancelar turno:', err.message);
            throw new Error('No se pudo cancelar el turno');
        }
    }
}

module.exports = new GoogleCalendarService();