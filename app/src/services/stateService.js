const NodeCache = require('node-cache');

class StateService {
    constructor(clientId) {
        this.clientId = clientId;
        this.cache = new NodeCache({ stdTTL: 3600 }); // 1 hour session
    }

    _getKey(jid) {
        return `${this.clientId}:${jid}`;
    }

    getUserState(jid) {
        return this.cache.get(this._getKey(jid)) || 'root';
    }

    setUserState(jid, state) {
        this.cache.set(this._getKey(jid), state);
    }

    resetUserState(jid) {
        this.cache.del(this._getKey(jid));
        this.cache.del(this._getKey(jid) + ':order');
        this.cache.del(this._getKey(jid) + ':datos');
    }

    addItemToOrder(jid, item) {
        const key = this._getKey(jid) + ':order';
        const currentOrder = this.cache.get(key) || [];
        const newItem = typeof item === 'string' ? { text: item, price: 0, quantity: 1 } : item;
        const newTitle = newItem.text.includes(' x ') ? newItem.text.substring(newItem.text.indexOf(' x ') + 3).trim() : newItem.text;

        const existing = currentOrder.find(ex => {
            const exTitle = ex.text.includes(' x ') ? ex.text.substring(ex.text.indexOf(' x ') + 3).trim() : ex.text;
            return exTitle === newTitle;
        });

        if (existing) {
            existing.quantity += newItem.quantity;
            if (existing.text.includes(' x ')) {
                const titlePart = existing.text.substring(existing.text.indexOf(' x '));
                existing.text = `${existing.quantity}${titlePart}`;
            }
        } else {
            currentOrder.push(newItem);
        }

        this.cache.set(key, currentOrder);
    }

    getUserOrder(jid) {
        return this.cache.get(this._getKey(jid) + ':order') || [];
    }

    clearUserOrder(jid) {
        this.cache.del(this._getKey(jid) + ':order');
    }

    addDatosText(jid, text) {
        const key = this._getKey(jid) + ':datos';
        const existing = this.cache.get(key) || '';
        this.cache.set(key, existing + (existing ? '\n' : '') + text);
    }

    getDatosText(jid) {
        return this.cache.get(this._getKey(jid) + ':datos') || '';
    }

    clearDatosText(jid) {
        this.cache.del(this._getKey(jid) + ':datos');
    }

    setPendingQuantityItem(jid, itemTitle) {
        this.cache.set(this._getKey(jid) + ':pending_qty', itemTitle, 600); // 10 min expiry
    }

    getPendingQuantityItem(jid) {
        return this.cache.get(this._getKey(jid) + ':pending_qty');
    }

    clearPendingQuantityItem(jid) {
        this.cache.del(this._getKey(jid) + ':pending_qty');
    }

    setPendingOrderItem(jid, item) {
        this.cache.set(this._getKey(jid) + ':pending_order', item, 600);
    }

    getPendingOrderItem(jid) {
        return this.cache.get(this._getKey(jid) + ':pending_order');
    }

    clearPendingOrderItem(jid) {
        this.cache.del(this._getKey(jid) + ':pending_order');
    }

    appendToLastOrderItem(jid, suffix) {
        const key = this._getKey(jid) + ':order';
        const currentOrder = this.cache.get(key) || [];
        if (currentOrder.length > 0) {
            const lastIndex = currentOrder.length - 1;
            currentOrder[lastIndex] = currentOrder[lastIndex] + ` (${suffix})`;
            this.cache.set(key, currentOrder);
        }
    }

    setWaitingForData(jid, nodeId) {
        this.cache.set(this._getKey(jid) + ':waiting_data', nodeId, 600);
    }

    getWaitingForData(jid) {
        return this.cache.get(this._getKey(jid) + ':waiting_data');
    }

    clearWaitingForData(jid) {
        this.cache.del(this._getKey(jid) + ':waiting_data');
    }

    setWaitingForFile(jid, nodeId) {
        this.cache.set(this._getKey(jid) + ':waiting_file', nodeId, 600);
    }

    getWaitingForFile(jid) {
        return this.cache.get(this._getKey(jid) + ':waiting_file');
    }

    clearWaitingForFile(jid) {
        this.cache.del(this._getKey(jid) + ':waiting_file');
    }
}

module.exports = StateService;
