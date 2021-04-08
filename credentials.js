const keytar = require('keytar');
const Configstore = require('configstore');

const CONFIGSTORE_EMAIL_KEY = process.env.NODE_ENV === 'development' ? 'ethernal-dev.email' : 'ethernal.email';
const KEYCHAIN_NAMESPACE = process.env.NODE_ENV === 'development' ? 'ethernal-dev:firebase' : 'ethernal:firebase';

const configstore = new Configstore(CONFIGSTORE_EMAIL_KEY);

var _setEmail = async function(email) {
    return await configstore.set(CONFIGSTORE_EMAIL_KEY, email);
};

var _setPassword = async function(email, password) {
    return await keytar.setPassword(KEYCHAIN_NAMESPACE, email, password);
}

module.exports = {
    getEmail: async () => {
        return await configstore.get(CONFIGSTORE_EMAIL_KEY);
    },
    getPassword: async (email) => {
        return await keytar.getPassword(KEYCHAIN_NAMESPACE, email);
    },
    set: async (email, password) => {
        await _setEmail(email);
        await _setPassword(email, password);
    },
};
