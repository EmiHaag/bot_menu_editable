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
    }

    addItemToOrder(jid, item) {
        const key = this._getKey(jid) + ':order';
        const currentOrder = this.cache.get(key) || [];
        if (typeof item === 'string') {
            currentOrder.push({ text: item, price: 0, quantity: 1 });
        } else {
            currentOrder.push(item);
        }
        this.cache.set(key, currentOrder);
    }

    getUserOrder(jid) {
        return this.cache.get(this._getKey(jid) + ':order') || [];
    }

    clearUserOrder(jid) {
        this.cache.del(this._getKey(jid) + ':order');
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
