#!/usr/bin/env node

const yargs = require('yargs');
const Web3 = require('web3');
const ethers = require('ethers');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const firebase = require('../firebase');
const credentials = require('../credentials');
const inquirer = require('../inquirer');

const PROJECT_TYPES = {
    TRUFFLE: {
        dir: 'build/contracts',
        func: getTruffleArtifact,
        name: 'Truffle'
    },
    HARDHAT: {
        dir: 'artifacts/build-info',
        func: getHardhatArtifact,
        name: 'Truffle'
    }
};

const options = yargs
    .command('login', 'Login to your Ethernal account', {}, setLogin)
    .command('listen', 'Start listening for transactions', (yargs) => {
        return yargs
            .option('w', { alias: 'workspace', describe: 'Workspace to connect to.', type: 'string', demandOption: false })
            .option('d', { alias: 'dir', type: 'array', describe: 'Project directory to watch', demandOption: false })
            .option('s', { alias: 'server', describe: 'Do not watch for artifacts change - only listen for transactions', demandOption: false })
            .option('l', { alias: 'local', describe: 'Do not listen for transactions - only watch contracts', demandOption: false })
    }, listen)
    .argv;

let web3, user, rpcServer;
let contractAddresses = {};
let db = new firebase.DB();

async function connect() {
    if (options.local) {
        console.log('Local option activated - only watching for contract changes');
        watchDirectories();
        if (options.server) {
            console.warn("You also passed the server option, but it won't be used, transactions won't be watched.");
        }
    }
    else {
        var settings = await db.settings();
        rpcServer = new URL(db.workspace.rpcServer);
        var provider = Web3.providers.WebsocketProvider;
        if (rpcServer.protocol == 'http' || rpcServer.protocol == 'https') {
            provider = Web3.providers.HttpProvider;
        }

        web3 = new Web3(new provider(rpcServer));
        subscribe();
    }
}

async function subscribe() {
    web3.eth.subscribe('newBlockHeaders')
        .on('connected', onConnected)
        .on('data', onData)
        .on('error', onError);
}

function watchDirectories() {
    var workingDirectories = options.dir ? options.dir : ['.'];
    console.log(`Watching following directories for artifacts: ${workingDirectories}`);
    workingDirectories.forEach((dir) => {
        var projectType = getProjectType(dir);
        if (projectType) {
            console.log(`Detected ${projectType.name} project for ${dir}`)
            watchArtifacts(dir, projectType);
        }
    });
}

function onConnected() {
    console.log(`Connected to ${rpcServer}`);
    if (options.server) {
        console.log('Server option activated - only listening to transactions');
    }
    else {
        watchDirectories();
    }
}

function onData(blockHeader, error) {
    if (error) {
        return console.log(error);
    }

    web3.eth.getBlock(blockHeader.hash, true).then(syncBlock);
}

function onError(error) {
    if (error) {
        console.log(error);
    }
}

function getProjectType(dir) {
    if (!dir) {
        console.log('Please specify a directory to check.');
        return;
    }
    var truffleConfigPath = path.format({
        dir: dir,
        base: 'truffle-config.js'
    });

    var hardhatConfigPath = path.format({
        dir: dir,
        base: 'hardhat.config.js'
    });

    var isTruffleProject = fs.existsSync(truffleConfigPath);
    var isHardhatProject = fs.existsSync(hardhatConfigPath);

    if (!isTruffleProject && !isHardhatProject) {
        console.log(`${dir} does not contain a truffle-config.js or hardhat.config.js file, contracts won't be uploaded automatically.`);
        return false;
    }
    if (isTruffleProject)
        return PROJECT_TYPES.TRUFFLE;
    else
        return PROJECT_TYPES.HARDHAT;
}

function updateContractArtifact(contract) {
    if (!contract) {
        return;
    }
    var storeArtifactPromise = db.contractStorage(`${contract.address}/artifact`).set(contract.artifact);
    var storeDependenciesPromise = db.contractStorage(`${contract.address}/dependencies`).set(contract.dependencies);

    Promise.all([storeArtifactPromise, storeDependenciesPromise]).then(() => {
        db.collection('contracts')
            .doc(contract.address)
            .set({
                name: contract.name,
                address: contract.address,
                abi: contract.abi
            }, { merge: true })
            .then(() => console.log(`Updated artifacts for contract ${contract.name} (${contract.address}), with dependencies: ${Object.entries(contract.dependencies).map(art => art[0]).join(', ')}`));
    });
}

function watchArtifacts(dir, projectConfig) {
    if (!dir) {
        console.log('Please specify a directory to watch.');
        return;
    }
    var artifactsDir = path.format({
        dir: dir,
        base: projectConfig.dir
    });
    console.log(`Starting watcher for ${artifactsDir}`);
    const watcher = chokidar.watch('.', { cwd: artifactsDir })
        .on('add', (path) => {
            console.log(`Got add event for ${path}`);
            updateContractArtifact(projectConfig.func(artifactsDir, path));
        })
        .on('change', (path) => {
            console.log(`change event for ${path}`);
            updateContractArtifact(projectConfig.func(artifactsDir, path));
        });
}

function getTruffleArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var contract;
    if (fileName != 'Migrations.json') {
        var rawArtifact = fs.readFileSync(path.format({ dir: artifactsDir, base: fileName }), 'utf8');
        var parsedArtifact = JSON.parse(rawArtifact);
        var contractAddress = parsedArtifact.networks[db.workspace.networkId] ? parsedArtifact.networks[db.workspace.networkId].address : null;
        if (contractAddress && contractAddress != contractAddresses[parsedArtifact.contractName]) {
            contractAddresses[parsedArtifact.contractName] = contractAddress;
            var artifactDependencies = getArtifactDependencies(parsedArtifact);
            for (const key in artifactDependencies) {
                var dependencyArtifact =  JSON.parse(fs.readFileSync(path.format({ dir: artifactsDir, base: `${key}.json`}), 'utf8'));
                artifactDependencies[key] = JSON.stringify({
                    contractName: dependencyArtifact.contractName,
                    abi: dependencyArtifact.abi,
                    ast: dependencyArtifact.ast,
                    source: dependencyArtifact.source,
                })
            }
            contract = {
                name: parsedArtifact.contractName,
                address: contractAddress,
                abi: parsedArtifact.abi,
                artifact: JSON.stringify({
                    contractName: parsedArtifact.contractName,
                    abi: parsedArtifact.abi,
                    ast: parsedArtifact.ast,
                    source: parsedArtifact.source,
                }),
                dependencies: artifactDependencies
            }
        }
    }
    return contract;
}

function getHardhatArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var rawArtifact = fs.readFileSync(path.format({ dir: artifactsDir, base: fileName }), 'utf8');
    var parsedArtifact = JSON.parse(rawArtifact);
    var contractAddress = fileName.split('.')[0];
    var contract = {
        address: contractAddress
    };

    var contracts = {};
    for (var contractDir in parsedArtifact.output.contracts) {
        for (var contractName in parsedArtifact.output.contracts[contractDir]) {
            contracts[contractDir] = {
                contractName: contractName,
                abi: parsedArtifact.output.contracts[contractDir][contractName].abi
            };
        }

        contracts.push({
            name: parsedArtifact.output.contracts[contractDir].name,
            abi: parsedArtifact.output.contracts[contractDir].abi
        });
    }
}

function getArtifactDependencies(parsedArtifact) {
    var dependencies = {}
    Object.entries(parsedArtifact.ast.exportedSymbols)
        .forEach(symbol => {
            if (symbol[0] != parsedArtifact.contractName) {
                dependencies[symbol[0]] = null;
            }
        });    
    return dependencies;
}

function syncBlock(block) {
    var sBlock = sanitize(block);
    db.collection('blocks').doc(sBlock.number.toString()).set(sBlock).then(() => console.log(`Synced block ${sBlock.number}`));

    sBlock.transactions.forEach(transaction => {
        web3.eth.getTransactionReceipt(transaction.hash).then(receipt => syncTransaction(sBlock, transaction, receipt));
    });
}

async function syncTransaction(block, transaction, transactionReceipt) {
    var sTransaction = sanitize(transaction);
    var txSynced = {
        ...sTransaction,
        receipt: transactionReceipt,
        timestamp: block.timestamp
    }

    if (transaction.to && transaction.input && transaction.value) {
        txSynced.functionSignature = await getFunctionSignatureForTransaction(sTransaction);    
    }
    
    db.collection('transactions')
        .doc(sTransaction.hash)
        .set(txSynced)
        .then(() => console.log(`Synced transaction ${sTransaction.hash}`));

    if (!txSynced.to) {
        db.collection('contracts')
            .doc(transactionReceipt.contractAddress)
            .set({ address: transactionReceipt.contractAddress })
            .then(() => console.log(`Synced new contract at ${transactionReceipt.contractAddress}`));
    }
}

async function getFunctionSignatureForTransaction(transaction) {
    var doc = await db.collection('contracts').doc(transaction.to).get();

    if (!doc || !doc.exists) {
        return null;
    }

    var abi = doc.data().abi;

    if (!abi) {
        return null;
    }

    var jsonInterface = new ethers.utils.Interface(abi);

    var parsedTransactionData = jsonInterface.parseTransaction({ data: transaction.input, value: transaction.value });
    var fragment = parsedTransactionData.functionFragment;

    return `${fragment.name}(` + fragment.inputs.map((input) => `${input.type} ${input.name}`).join(', ') + ')'
}

function sanitize(obj) {    
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));
}

async function setLogin() {
    do {
        const newCredentials = await inquirer.login();
        try {
            user = (await firebase.auth().signInWithEmailAndPassword(newCredentials.email, newCredentials.password)).user;
            await credentials.set(newCredentials.email, newCredentials.password);
            console.log('You are now logged in. Run "ethernal listen" to get started.')
            process.exit(0);
        }
        catch(error) {
            console.log(error.message);
        }
    } while (user === undefined);
}

async function login() {
    try {
        var email = await credentials.getEmail();
        if (!email) {
            return console.log('You are not logged in, please run "ethernal login".')
        }
        else {
            var password = await credentials.getPassword(email);
            if (!password) {
                return console.log('You are not logged in, please run "ethernal login".')
            }    
        }

        return (await firebase.auth().signInWithEmailAndPassword(email, password)).user;
    }
    catch(_error) {
        console.log('Error while retrieving your credentials, please run "ethernal login"');
    }
}

async function getDefaultWorkspace() {
    var workspaces = await db.workspaces();
    var defaultWorkspace = await db.getWorkspace(workspaces[0]);
    return defaultWorkspace;
}

async function setWorkspace() {
    if (options.workspace) {
        currentWorkspace = await db.getWorkspace(options.workspace);
        if (!currentWorkspace) {
            currentWorkspace = await getDefaultWorkspace();
            console.log(`Could not find workspace "${options.workspace}", defaulting to ${currentWorkspace.name}`);
        }
        else {
            console.log(`Using workspace "${currentWorkspace.name}"`);
        }
    }
    else {
        currentWorkspace = await getDefaultWorkspace();
        console.log(`Using default workspace "${currentWorkspace.name}"`);
    }
    db.workspace = currentWorkspace;    
}

async function listen() {
    user = await login();
    if (!user) {
        process.exit(1);
    }
    console.log(`Logged in with ${await credentials.getEmail()}`);

    await setWorkspace();
    connect();
}

