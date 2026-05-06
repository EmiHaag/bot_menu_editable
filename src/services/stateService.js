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
    }
}

module.exports = StateService;
