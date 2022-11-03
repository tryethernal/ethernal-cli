const axios = require('axios');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, connectAuthEmulator } = require('firebase/auth');
const { BlockWithTransactions, TransactionResponse, TransactionReceipt } = require('@ethersproject/abstract-provider');
const { FIREBASE_CONFIG } = require('./config');

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);

module.exports = class Api {
    apiRoot;
    firebaseUserId;
    currentUser;
    currentWorkspace;
    auth;

    constructor(apiRoot) {
        this.apiRoot = apiRoot;
        this.auth = auth;
        this.currentWorkspace = {};
        this.currentUser = {};
    }

    get isLoggedIn() {
        return !!this.currentUser.email;
    }

    get hasWorkspace() {
        return !!this.currentWorkspace;
    }

    get currentWorkspace() {
        return this.currentWorkspace;
    }

    get currentUser() {
        return { email: this.currentUser.email };
    }

    async getFirebaseAuthToken() {
        return this.auth && this.auth.currentUser ? await this.auth.currentUser.getIdToken() : null;
    }

    async login(email, password) {
        try {
            if (process.env.AUTH_HOST)
                connectAuthEmulator(auth, process.env.AUTH_HOST);

            await signInWithEmailAndPassword(this.auth, email, password);

            if (this.auth.currentUser) {
                this.firebaseUserId = this.auth.currentUser.uid;
                const firebaseAuthToken = await this.getFirebaseAuthToken();
                this.currentUser = (await axios.get(`${this.apiRoot}/api/users/me?firebaseAuthToken=${firebaseAuthToken}`)).data;
                if (this.currentUser.currentWorkspace)
                    this.currentWorkspace = this.currentUser.currentWorkspace;
            }
            else
                throw new Error(`Couldn't login with the specified email/password`);
        } catch(error) {
            if (error.code == 'auth/wrong-password')
                throw new Error(`Couldn't login with the specified email/password`);
            throw error;
        }
    }

    setWorkspace(workspace) {
        if (workspace && this.currentUser) {
            let foundWorkspace = false;
            for (let i = 0; i < this.currentUser.workspaces.length; i++) {
                const loopedWorkspace = this.currentUser.workspaces[i];
                if (loopedWorkspace.name == workspace) {
                    this.currentWorkspace = loopedWorkspace;
                    foundWorkspace = true;
                    break;
                }
            }
            if (!foundWorkspace)
                throw new Error(`Couldn't find workspace ${workspace}. Make sure you're logged in with the correct account.`);
        }

        return this.currentWorkspace;
    }

    async resetWorkspace(workspaceName) {
        if (!workspaceName)
            throw new Error('[resetWorkspace] Missing workspace name');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[resetWorkspace] You need to be authenticated to reset a workspace');
        
        return await axios.post(`${this.apiRoot}/api/workspaces/reset`, { firebaseAuthToken, data: { workspace: workspaceName }});
    }

    async syncBlockRange(from, to) {
        if (from === undefined || from === null || to === undefined || to === null)
            throw new Error('[syncBlockRange] Missing block range');

        const firebaseAuthToken = await this.getFirebaseAuthToken();

        if (!firebaseAuthToken)
            throw new Error('[syncBlockRange] You need to be authenticated to sync a block range');

        if (!this.currentWorkspace)
            throw new Error('[syncBlockRange] A workspace needs to be set to synchronize a block range');

        return await axios.post(`${this.apiRoot}/api/blocks/syncRange`, { firebaseAuthToken, data: { workspace: this.currentWorkspace.name, from: from, to: to }});
    }

    async syncBlock(block, serverSync = false) {
        if (!block)
            throw new Error('[syncBlock] Missing block');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[syncBlock] You need to be authenticated to reset a workspace');

        if (!this.currentWorkspace)
            throw new Error('[syncBlock] A workspace needs to be set to synchronize blocks.')

        return await axios.post(`${this.apiRoot}/api/blocks?serverSync=${serverSync}`, { firebaseAuthToken, data: { block: block, workspace: this.currentWorkspace.name }});
    }

    async syncTransaction(block, transaction, transactionReceipt) {
        if (!block || !transaction || !transactionReceipt)
            throw new Error('[syncTransaction] Missing parameter');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[syncTransaction] You need to be authenticated to reset a workspace');

        if (!this.currentWorkspace)
            throw new Error('[syncTransaction] The workspace needs to be set to synchronize blocks.');
        
        return await axios.post(`${this.apiRoot}/api/transactions`, {
            firebaseAuthToken,
            data: {
                block: block,
                transaction: transaction,
                transactionReceipt: transactionReceipt,
                workspace: this.currentWorkspace.name
            }
        });
    }

    async syncTrace(transactionHash, trace) {
        if (!transactionHash || !trace)
            throw new Error('[syncTrace] Missing parameter');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[syncTrace] You need to be authenticated to reset a workspace');

        if (!this.currentWorkspace)
            throw new Error('[syncTransaction] The workspace needs to be set to synchronize blocks.');
    
        return await axios.post(`${this.apiRoot}/api/transactions/${transactionHash}/trace`, {
            firebaseAuthToken,
            data: {
                txHash: transactionHash,
                steps: trace,
                workspace: this.currentWorkspace.name
            }
        });
    }

    async syncContractData(name, address, abi, hashedBytecode) {
        if (!name || !address)
            throw new Error('[syncContractData] Missing parameter');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[syncContractData] You need to be authenticated to reset a workspace');

        if (!this.currentWorkspace)
            throw new Error('[syncContractData] The workspace needs to be set to synchronize blocks.');

        return await axios.post(`${this.apiRoot}/api/contracts/${address}`, {
            firebaseAuthToken,
            data: {
                name: name,
                address: address,
                abi: abi,
                hashedBytecode: hashedBytecode, 
                workspace: this.currentWorkspace.name
            }
        });
    }

    async syncContractAst(address, ast) {
        if (!address || !ast)
            throw new Error('[syncContractAst] Missing parameter');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[syncContractData] You need to be authenticated to reset a workspace');

        if (!this.currentWorkspace)
            throw new Error('[syncContractAst] The workspace needs to be set to synchronize blocks');

        return await axios.post(`${this.apiRoot}/api/contracts/${address}`, {
            firebaseAuthToken,
            data: {
                ast: ast,
                workspace: this.currentWorkspace.name
            }
        });
    }

    async syncTrace(transactionHash, trace) {
        if (!transactionHash || !trace)
            throw new Error('[syncTrace] Missing parameter');

        const firebaseAuthToken = await this.getFirebaseAuthToken();
        if (!firebaseAuthToken)
            throw new Error('[syncTrace] You need to be authenticated to reset a workspace');

        if (!this.currentWorkspace)
            throw new Error('[syncTrace] The workspace needs to be set to synchronize blocks.');
    
        return await axios.post(`${this.apiRoot}/api/transactions/${transactionHash}/trace`, {
            firebaseAuthToken,
            data: {
                txHash: transactionHash,
                steps: trace,
                workspace: this.currentWorkspace.name
            }
        });
    }
}
