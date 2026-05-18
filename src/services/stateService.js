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
        currentOrder.push(item);
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

    setWaitingForData(jid, nodeId) {
        this.cache.set(this._getKey(jid) + ':waiting_data', nodeId, 600);
    }

    getWaitingForData(jid) {
        return this.cache.get(this._getKey(jid) + ':waiting_data');
    }

    clearWaitingForData(jid) {
        this.cache.del(this._getKey(jid) + ':waiting_data');
    }
}

module.exports = StateService;
