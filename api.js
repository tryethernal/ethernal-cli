const axios = require('axios');
const { BlockWithTransactions, TransactionResponse, TransactionReceipt } = require('@ethersproject/abstract-provider');

module.exports = class Api {
    apiRoot;
    firebaseUserId;
    currentUser;
    currentWorkspace;
    auth;
    apiToken;

    constructor(apiRoot) {
        this.apiRoot = apiRoot;
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

    get isUsingApiToken() {
        return !!this.apiToken;
    }

    get currentUser() {
        return { email: this.currentUser.email };
    }

    async setApiToken(apiToken) {
        try {
            this.apiToken = apiToken;
            axios.defaults.headers.common['authorization'] = `Bearer ${this.apiToken}`;
            return await this.fetchUser();
        } catch(error) {
            throw error;
        }
    }

    async fetchUser() {
        if (!this.isUsingApiToken)
            throw new Error('You need to authenticate first.');

        this.currentUser = (await axios.get(`${this.apiRoot}/api/users/me`)).data;

        if (!this.currentUser.workspaces.length)
            throw new Error(`You need to create a new workspace on ${this.webappRoot} before using the plugin.`);

        if (this.currentUser.currentWorkspace)
            this.currentWorkspace = this.currentUser.currentWorkspace;
        else {
            await this.setWorkspace(this.currentUser.workspaces[0].name);
            await axios.post(`${this.apiRoot}/api/users/me/setCurrentWorkspace`, { data: { workspace: this.currentUser.workspaces[0].name }});
        }

        return this.currentWorkspace;
    }

    async login(email, password) {
        try {
            if (this.apiToken)
                throw new Error('Authenticating with API token.');

            const { data: { user } } = await axios.post(`${this.apiRoot}/api/users/signin`, { email, password });

            if (user)
                await this.setApiToken(user.apiToken);
            else
                throw new Error(`Couldn't login with the specified email/password.`);

        } catch(error) {
            console.log(error);
            throw new Error(`Couldn't login with the specified email/password.`);
        }
    }

    async setWorkspace(workspace) {
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

            if (!this.isUsingApiToken)
                throw new Error('[setWorkspace] You need to be authenticated to set a workspace.');
        }

        return this.currentWorkspace;
    }

    async resetWorkspace(workspaceName) {
        if (!workspaceName)
            throw new Error('[resetWorkspace] Missing workspace name.');

        if (!this.isUsingApiToken)
            throw new Error('[resetWorkspace] You need to be authenticated to reset a workspace.');
        
        return await axios.post(`${this.apiRoot}/api/workspaces/reset`, { data: { workspace: workspaceName }});
    }

    async syncBlockRange(from, to) {
        if (from === undefined || from === null || to === undefined || to === null)
            throw new Error('[syncBlockRange] Missing block range.');

        if (!this.isUsingApiToken)
            throw new Error('[syncBlockRange] You need to be authenticated to synchronize a block range.');

        if (!this.currentWorkspace)
            throw new Error('[syncBlockRange] A workspace needs to be set to synchronize a block range.');

        return await axios.post(`${this.apiRoot}/api/blocks/syncRange`, { data: { workspace: this.currentWorkspace.name, from: from, to: to }});
    }

    async syncBlock(block, serverSync = false) {
        if (!block)
            throw new Error('[syncBlock] Missing block');

        if (!this.isUsingApiToken)
            throw new Error('[syncBlock] You need to be authenticated to synchronize transactions.');

        if (!this.currentWorkspace)
            throw new Error('[syncBlock] A workspace needs to be set to synchronize blocks.')

        return await axios.post(`${this.apiRoot}/api/blocks?serverSync=${serverSync}`, { data: { block: block, workspace: this.currentWorkspace.name }});
    }

    async syncTransaction(block, transaction, transactionReceipt) {
        if (!block || !transaction || !transactionReceipt)
            throw new Error('[syncTransaction] Missing parameter?');

        if (!this.isUsingApiToken)
            throw new Error('[syncTransaction] You need to be authenticated to synchronize transactions.');

        if (!this.currentWorkspace)
            throw new Error('[syncTransaction] The workspace needs to be set to synchronize transactions.');
        
        return await axios.post(`${this.apiRoot}/api/transactions`, {
            data: {
                block: block,
                transaction: transaction,
                transactionReceipt: transactionReceipt,
                workspace: this.currentWorkspace.name
            }
        });
    }

    async syncContractData(name, address, abi, hashedBytecode) {
        if (!name || !address)
            throw new Error('[syncContractData] Missing parameter.');

        if (!this.isUsingApiToken)
            throw new Error('[syncContractData] You need to be authenticated to synchronize contract data.');

        if (!this.currentWorkspace)
            throw new Error('[syncContractData] The workspace needs to be set to synchronize contract data.');

        return await axios.post(`${this.apiRoot}/api/contracts/${address}`, {
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
            throw new Error('[syncContractAst] Missing parameter.');

        if (!this.isUsingApiToken)
            throw new Error('[syncContractAst] You need to be authenticated to synchronize contract data.');

        if (!this.currentWorkspace)
            throw new Error('[syncContractAst] The workspace needs to be set to synchronize contract data.');

        return await axios.post(`${this.apiRoot}/api/contracts/${address}`, {
            data: {
                ast: ast,
                workspace: this.currentWorkspace.name
            }
        });
    }

    async syncTrace(transactionHash, trace) {
        if (!transactionHash || !trace)
            throw new Error('[syncTrace] Missing parameter.');

        if (!this.isUsingApiToken)
            throw new Error('[syncTrace] You need to be authenticated to synchronize transactions trace.');

        if (!this.currentWorkspace)
            throw new Error('[syncTrace] The workspace needs to be set to synchronize tranactions trace.');
    
        return await axios.post(`${this.apiRoot}/api/transactions/${transactionHash}/trace`, {
            data: {
                txHash: transactionHash,
                steps: trace,
                workspace: this.currentWorkspace.name
            }
        });
    }
}
