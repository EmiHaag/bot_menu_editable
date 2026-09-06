/**
 * MenuDbService: adapter de acceso al menú/catálogo desde PostgreSQL (Neon).
 * Reemplaza a GoogleSheetsService como fuente de datos del menú manteniendo la
 * MISMA interfaz (getMenuData/getNodeById/getNodesByParent/addNode/updateNode/
 * deleteNodeAndChildren/deleteRow/clearCache) para que MenuController,
 * AITranslatorController y el dashboard sigan funcionando sin cambios.
 *
 * Los nodos devueltos conservan el formato del modelo de Sheets:
 *   disponible/strictTrigger como strings 'true'/'false',
 *   price como string, id/parentId como node_id strings.
 */
const { neon } = require('@neondatabase/serverless');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 });

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

function parseBool(value) {
    return String(value).toLowerCase() === 'true';
}

function precioToDb(precio) {
    if (precio === null || precio === undefined || precio === '') return 0;
    const n = parseFloat(String(precio).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

function precioToDisplay(precio) {
    if (precio === null || precio === undefined) return '';
    const n = Number.parseFloat(precio);
    if (!Number.isFinite(n) || n === 0) return '';
    return String(Number.parseFloat(n.toFixed(2)));
}

function imagenesToDb(value) {
    if (value == null) return '[]';
    let arr = value;
    if (typeof value === 'string') {
        try {
            arr = JSON.parse(value);
        } catch (e) {
            arr = [];
        }
    }
    if (!Array.isArray(arr)) return '[]';
    return JSON.stringify(arr.filter(img => img && img.url));
}

function mapRow(row) {
    let imagenes = [];
    if (row.imagenes) {
        try {
            imagenes = Array.isArray(row.imagenes) ? row.imagenes : JSON.parse(row.imagenes);
        } catch (e) {
            imagenes = [];
        }
    }
    return {
        idClient: row.comercio_id,
        id: row.node_id,
        parentId: row.parent_node_id || '',
        title: row.titulo,
        message: row.mensaje || '',
        trigger: row.trigger || '',
        price: precioToDisplay(row.precio),
        strictTrigger: row.strict_trigger ? 'true' : 'false',
        redirigirA: row.redirigir_a || '',
        disponible: row.disponible === false ? 'false' : 'true',
        imagenes,
        rowIndex: row.row_index != null ? row.row_index : row.id
    };
}

async function ensureMenuTables() {
    if (!sql) {
        console.error('[MenuDbService] NEON_DATABASE_URL not set, menu DB disabled');
        return;
    }
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS menu_nodos (
                id SERIAL PRIMARY KEY,
                comercio_id VARCHAR(100) NOT NULL,
                node_id VARCHAR(100) NOT NULL,
                parent_node_id VARCHAR(100) NULL,
                titulo VARCHAR(200) NOT NULL DEFAULT '',
                mensaje TEXT NOT NULL DEFAULT '',
                trigger VARCHAR(50) NOT NULL DEFAULT '',
                precio NUMERIC(12, 2) NOT NULL DEFAULT 0,
                strict_trigger BOOLEAN NOT NULL DEFAULT false,
                redirigir_a VARCHAR(100) NULL,
                disponible BOOLEAN NOT NULL DEFAULT true,
                row_index INT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await sql`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_nodos_uq ON menu_nodos (comercio_id, node_id)
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_menu_nodos_parent ON menu_nodos (comercio_id, parent_node_id)
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_menu_nodos_comercio ON menu_nodos (comercio_id)
        `;
        await sql`
            CREATE INDEX IF NOT EXISTS idx_menu_nodos_busqueda ON menu_nodos
            USING gin (
                to_tsvector('spanish',
                    coalesce(titulo, '') || ' ' ||
                    coalesce(regexp_replace(mensaje, '##[A-Z_]+##', '', 'g'), '')
                )
            )
        `;
        await sql`
            ALTER TABLE menu_nodos ADD COLUMN IF NOT EXISTS imagenes JSONB NOT NULL DEFAULT '[]'::jsonb
        `;
        await sql`
            ALTER TABLE bots ADD COLUMN IF NOT EXISTS nombre_negocio VARCHAR(100) NOT NULL DEFAULT ''
        `;
        console.log('[MenuDbService] Tables menu_nodos ready');
    } catch (err) {
        console.error('[MenuDbService] Error ensuring tables:', err.message);
    }
}

class MenuDbService {
    constructor(config) {
        config = config || {};
        this.clientId = config.clientId || config.idCliente;
        this.spreadsheetId = config.spreadsheetId || '';
    }

    get _cacheKey() {
        return `menu_db_${this.clientId}`;
    }

    clearCache() {
        cache.del(this._cacheKey);
    }

    async _getAllRows() {
        return sql`
            SELECT * FROM menu_nodos
            WHERE comercio_id = ${this.clientId}
            ORDER BY row_index ASC NULLS LAST, id ASC
        `;
    }

    async initializeClientSheet() {
        if (!sql || !this.clientId) return;
        const count = await sql`SELECT COUNT(*) AS c FROM menu_nodos WHERE comercio_id = ${this.clientId}`;
        if (Number(count[0].c) === 0) {
            await sql`
                INSERT INTO menu_nodos (comercio_id, node_id, parent_node_id, titulo, mensaje, trigger, precio)
                VALUES (${this.clientId}, 'root', NULL, 'Inicio', 'Hola bienvenido a .. ', '0', 0)
                ON CONFLICT (comercio_id, node_id) DO NOTHING
            `;
            this.clearCache();
        }
    }

    async getMenuData() {
        if (!sql) return [];
        const cached = cache.get(this._cacheKey);
        if (cached) return cached;
        const rows = await this._getAllRows();
        if (rows.length === 0 && this.clientId && this.clientId !== 'admin') {
            await this.initializeClientSheet();
            this.clearCache();
            const rows2 = await this._getAllRows();
            const menu = rows2.map(mapRow);
            cache.set(this._cacheKey, menu);
            return menu;
        }
        const menu = rows.map(mapRow);
        cache.set(this._cacheKey, menu);
        return menu;
    }

    async getNodesByParent(parentId) {
        if (!sql) return [];
        const menu = await this.getMenuData();
        return menu.filter(node => (node.parentId || '') === (parentId || ''));
    }

    async getNodeById(id) {
        if (!sql) return null;
        const menu = await this.getMenuData();
        return menu.find(node => node.id === id) || null;
    }

    async deleteNodeAndChildren(nodeId) {
        if (!sql || !nodeId) return;
        const menu = await this.getMenuData();
        const toDelete = new Set();
        const findChildren = (id) => {
            const children = menu.filter(node => node.parentId === id);
            children.forEach(child => {
                toDelete.add(child.id);
                findChildren(child.id);
            });
        };
        toDelete.add(nodeId);
        findChildren(nodeId);
        if (toDelete.size > 0) {
            const borrados = await sql`
                DELETE FROM menu_nodos
                WHERE comercio_id = ${this.clientId} AND node_id = ANY(${Array.from(toDelete)})
                RETURNING imagenes
            `;
            this._borrarImagenesDrive(borrados);
            this.clearCache();
        }
    }

    _borrarImagenesDrive(rows) {
        try {
            const googleDriveService = require('./googleDriveService');
            for (const row of rows || []) {
                let imagenes = [];
                try {
                    imagenes = Array.isArray(row.imagenes) ? row.imagenes : JSON.parse(row.imagenes || '[]');
                } catch (e) {}
                for (const img of imagenes) {
                    if (img && img.driveFileId) {
                        try {
                            googleDriveService.deleteFile(img.driveFileId);
                        } catch (e) {
                            console.error('[MenuDbService] No se pudo borrar imagen de Drive:', e.message);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[MenuDbService] Error borrando imágenes de Drive:', e.message);
        }
    }

    async getImagenesActuales(id, index) {
        if (!sql) return [];
        if (id) {
            const rows = await sql`
                SELECT imagenes FROM menu_nodos
                WHERE comercio_id = ${this.clientId} AND node_id = ${id}
            `;
            const row = rows && rows[0];
            return row ? this._parseImagenes(row.imagenes) : [];
        }
        if (index != null) {
            const rows = await sql`
                SELECT imagenes FROM menu_nodos
                WHERE comercio_id = ${this.clientId} AND row_index = ${Number(index)}
            `;
            const row = rows && rows[0];
            return row ? this._parseImagenes(row.imagenes) : [];
        }
        return [];
    }

    _parseImagenes(value) {
        if (Array.isArray(value)) return value;
        try {
            return JSON.parse(value || '[]') || [];
        } catch (e) {
            return [];
        }
    }

    async _borrarImagenesRemovidas(viejas, nuevas) {
        const nuevosIds = (Array.isArray(nuevas) ? nuevas : []).map(i => i && i.driveFileId).filter(Boolean);
        const removidas = (Array.isArray(viejas) ? viejas : [])
            .filter(i => i && i.driveFileId && !nuevosIds.includes(i.driveFileId));
        if (removidas.length === 0) return;
        const googleDriveService = require('./googleDriveService');
        for (const img of removidas) {
            try {
                await googleDriveService.deleteFile(img.driveFileId);
            } catch (e) {
                console.error('[MenuDbService] No se pudo borrar imagen de Drive:', e.message);
            }
        }
    }

    async updateNode(index, nodeData) {
        if (!sql) return;
        const data = nodeData || {};
        const id = data.id != null && String(data.id).trim() !== '' ? String(data.id).trim() : null;

        const viejas = await this.getImagenesActuales(id, index);
        const nuevas = this._parseImagenes(data.imagenes);

        if (id) {
            await sql`
                UPDATE menu_nodos SET
                    node_id = ${id},
                    parent_node_id = ${data.parentId || null},
                    titulo = ${data.title || ''},
                    mensaje = ${data.message || ''},
                    trigger = ${data.trigger || ''},
                    precio = ${precioToDb(data.price)},
                    strict_trigger = ${parseBool(data.strictTrigger)},
                    redirigir_a = ${data.redirigirA || null},
                    disponible = ${data.disponible === 'false' ? false : true},
                    imagenes = ${imagenesToDb(data.imagenes)}::jsonb,
                    updated_at = NOW()
                WHERE comercio_id = ${this.clientId} AND node_id = ${id}
            `;
        } else if (index != null) {
            await sql`
                UPDATE menu_nodos SET
                    node_id = ${data.id || ''},
                    parent_node_id = ${data.parentId || null},
                    titulo = ${data.title || ''},
                    mensaje = ${data.message || ''},
                    trigger = ${data.trigger || ''},
                    precio = ${precioToDb(data.price)},
                    strict_trigger = ${parseBool(data.strictTrigger)},
                    redirigir_a = ${data.redirigirA || null},
                    disponible = ${data.disponible === 'false' ? false : true},
                    imagenes = ${imagenesToDb(data.imagenes)}::jsonb,
                    updated_at = NOW()
                WHERE comercio_id = ${this.clientId} AND row_index = ${Number(index)}
            `;
        }
        await this._borrarImagenesRemovidas(viejas, nuevas);
        this.clearCache();
    }

    async addNode(nodeData) {
        if (!sql) return;
        const data = nodeData || {};
        await sql`
            INSERT INTO menu_nodos (comercio_id, node_id, parent_node_id, titulo, mensaje, trigger, precio, strict_trigger, redirigir_a, disponible, imagenes)
            VALUES (${this.clientId}, ${data.id || ''}, ${data.parentId || null}, ${data.title || ''}, ${data.message || ''}, ${data.trigger || ''}, ${precioToDb(data.price)}, ${parseBool(data.strictTrigger)}, ${data.redirigirA || null}, ${data.disponible === 'false' ? false : true}, ${imagenesToDb(data.imagenes)}::jsonb)
            ON CONFLICT (comercio_id, node_id) DO NOTHING
        `;
        this.clearCache();
    }

    async deleteRow(index) {
        if (!sql || index == null) return;
        const borrados = await sql`
            DELETE FROM menu_nodos WHERE comercio_id = ${this.clientId} AND row_index = ${Number(index)}
            RETURNING imagenes
        `;
        this._borrarImagenesDrive(borrados);
        this.clearCache();
    }
}

module.exports = { MenuDbService, ensureMenuTables, sql };