#!/usr/bin/env node

const yargs = require('yargs');
const Web3 = require('web3');
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
        return yargs.option('w', { alias: 'workspace', describe: 'Workspace to connect to.', type: 'string', demandOption: false })
            .option('d', { alias: 'dir', type: 'array', describe: 'Project directory to watch', demandOption: false })
    }, listen)
    .argv;

let web3, user, rpcServer;
let contractAddresses = {};
let db = new firebase.DB();

async function connect() {
    var settings = await db.settings();
    rpcServer = new URL(db.workspace.rpcServer);
    var provider = Web3.providers.WebsocketProvider;
    if (rpcServer.protocol == 'http' || rpcServer.protocol == 'https') {
        provider = Web3.providers.HttpProvider;
    }

    web3 = new Web3(new provider(rpcServer));
    subscribe();
}

async function subscribe() {
    web3.eth.subscribe('newBlockHeaders')
        .on('connected', onConnected)
        .on('data', onData)
        .on('error', onError);
}

function onConnected() {
    console.log(`Connected to ${rpcServer}`);
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

function updateContractArtifact(artifact) {
    if (!artifact) {
        return;
    }
    db.collection('contracts')
        .doc(artifact.address)
        .set({
            name: artifact.name,
            address: artifact.address,
            artifact: artifact.raw,
            dependencies: artifact.dependencies
        })
        .then(() => console.log(`Updated artifacts for contract ${artifact.name} (${artifact.address}), with dependencies: ${Object.entries(artifact.dependencies).map(art => art[1].name).join(', ')}`));
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
            console.log(`add event for ${path}`);
            updateContractArtifact(projectConfig.func(artifactsDir, path));
        })
        .on('change', (path) => {
            console.log(`change event for ${path}`);
            updateContractArtifact(projectConfig.func(artifactsDir, path));
        });
}

function getTruffleArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var contractArtifact;
    if (fileName != 'Migrations.json') {
        var rawArtifact = fs.readFileSync(path.format({ dir: artifactsDir, base: fileName }), 'utf8');
        var parsedArtifact = JSON.parse(rawArtifact);
        var contractAddress = parsedArtifact.networks[db.workspace.networkId] ? parsedArtifact.networks[db.workspace.networkId].address : null;
        if (contractAddress && contractAddress != contractAddresses[parsedArtifact.contractName]) {
            contractAddresses[parsedArtifact.contractName] = contractAddress;
            var artifactDependencies = getArtifactDependencies(parsedArtifact);
            for (const key in artifactDependencies) {
                artifactDependencies[key].artifact = fs.readFileSync(path.format({ dir: artifactsDir, base: `${artifactDependencies[key].name}.json`}), 'utf8');
            }
            contractArtifact = {
                address: contractAddress,
                name: parsedArtifact.contractName,
                raw: rawArtifact,
                parsed: parsedArtifact,
                dependencies: artifactDependencies,
            }
        }
    }
    return contractArtifact;
}

function getHardhatArtifact(artifactsDir, fileName) {
    var contractAddress;
}

function getArtifactDependencies(parsedArtifact) {
    var dependencies = {}
    Object.entries(parsedArtifact.ast.exportedSymbols)
        .forEach(symbol => {
            if (symbol[0] != parsedArtifact.contractName) {
                dependencies[symbol[1][0]] = {
                    name: symbol[0],
                    artifact: null
                }
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

function syncTransaction(block, transaction, transactionReceipt) {
    var sTransaction = sanitize(transaction);
    var txSynced = {
        ...sTransaction,
        receipt: transactionReceipt,
        timestamp: block.timestamp
    }
    db.collection('transactions')
        .doc(sTransaction.hash)
        .set(txSynced)
        .then(() => console.log(`Synced transaction ${sTransaction.hash}`));
}

function sanitize(obj) {    
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));
}

async function setLogin() {
    do {
        const newCredentials = await inquirer.login();
        try {
            user = (await firebase.auth().signInWithEmailAndPassword(newCredentials.email, newCredentials.password)).user;
            credentials.set(newCredentials.email, newCredentials.password);
            console.log('You are now logged in. Run "ethernal listen" to get started.')
            process.exit()
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
        return console.log('You are not logged in, please run "ethernal login".')
    }
    console.log(`Logged in with ${await credentials.getEmail()}`);

    await setWorkspace();
    connect();
}

