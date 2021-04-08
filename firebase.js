if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}
const firebase = require('firebase/app');
require('firebase/firestore');
require('firebase/database');
require('firebase/auth');

const { FIREBASE_CONFIG } = require('./config');

const app = firebase.initializeApp(FIREBASE_CONFIG);
const _db = app.firestore();
const _rtdb = firebase.database();
const _auth = firebase.auth;

var contractSerializer = {
    serialize: snapshot => {
        var res = snapshot.data();
        
        if (snapshot.data().artifact)
            Object.defineProperty(res, 'artifact', { value: JSON.parse(snapshot.data().artifact) })
        
        if (snapshot.data().storageStructure)
            Object.defineProperty(res, 'storageStructure', { value: JSON.parse(snapshot.data().storageStructure) })

        if (!snapshot.data().dependencies)
            Object.defineProperty(res, 'dependencies', { value: {} })

        return res
    }
};

var _DB = class DB {

    workspace;

    get userId() {
        return _auth().currentUser.uid;
    }

    collection(path) {
        if (!this.userId || !this.workspace) return;
        var ref = _db.collection('users')
            .doc(this.userId)
            .collection('workspaces')
            .doc(this.workspace.name)
            .collection(path);
        
        return ref;
    }

    contractStorage(contractAddress) {
        if (!this.userId || !this.workspace) return;
        return _rtdb.ref(`/users/${this.userId}/workspaces/${this.workspace.name}/contracts/${contractAddress}`);
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
    _auth().useEmulator(process.env.VUE_APP_AUTH_HOST);

    const rtdbSplit = process.env.VUE_APP_RTDB_HOST.split(':');
    _rtdb.useEmulator(rtdbSplit[0], rtdbSplit[1]);

    const firestoreSplit = process.env.VUE_APP_FIRESTORE_HOST.split(':');
    _db.useEmulator(firestoreSplit[0], firestoreSplit[1]);
}


module.exports = {
    DB: _DB,
    auth: firebase.auth
}
