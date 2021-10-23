if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}
const firebase = require('firebase/app');
require('firebase/firestore');
require('firebase/auth');
require('firebase/functions');

const { FIREBASE_CONFIG } = require('./config');

const app = firebase.initializeApp(FIREBASE_CONFIG);
const _db = app.firestore();
const _auth = firebase.auth;
const _functions = firebase.functions();

var _DB = class DB {

    workspace;

    get userId() {
        return _auth().currentUser.uid;
    }
    
    async settings() {
        if (!this.userId || !this.workspace) return;
        var snapshot = await _db.collection('users')
            .doc(this.userId)
            .collection('workspaces')
            .doc(this.workspace.name)
            .get();
        return snapshot.data().settings;
    }
    
    currentUser() {
        if (!this.userId) return;
        return _db.collection('users')
            .doc(this.userId);
    }

    async workspaces() {
        if (!this.userId) return;
        var res = [];
        var snapshot = await _db.collection('users')
            .doc(this.userId)
            .collection('workspaces')
            .get();
        snapshot.forEach(doc => res.push(doc.id));
        return res;
    }

    async getWorkspace(workspaceName) {
        if (!this.userId) return;
        var res = [];
        var snapshot = await _db.collection('users')
            .doc(this.userId)
            .collection('workspaces')
            .doc(workspaceName)
            .withConverter({
                fromFirestore: function(snapshot, options) {
                    return Object.defineProperty(snapshot.data(options), 'name', { value: workspaceName })
                }
            })
            .get();
        return snapshot.data();
    }
};

if (process.env.NODE_ENV == 'development') {
    _functions.useFunctionsEmulator(process.env.FUNCTIONS_HOST);
    _auth().useEmulator(process.env.AUTH_HOST);

    const firestoreSplit = process.env.FIRESTORE_HOST.split(':');
    _db.useEmulator(firestoreSplit[0], firestoreSplit[1]);
}

module.exports = {
    DB: _DB,
    auth: firebase.auth,
    functions: _functions
}
