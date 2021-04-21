#!/usr/bin/env node

const yargs = require('yargs');
const ethers = require('ethers');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const firebase = require('../firebase');
const credentials = require('../credentials');
const inquirer = require('../inquirer');
const TruffleConfig = require('@truffle/config');

const options = yargs
    .command('login', 'Login to your Ethernal account', {}, setLogin)
    .command('listen', 'Start listening for transactions', (yargs) => {
        return yargs
            .option('w', { alias: 'workspace', describe: 'Workspace to connect to.', type: 'string', demandOption: false })
            .option('d', { alias: 'dir', type: 'array', describe: 'Project directory to watch', demandOption: false })
            .option('s', { alias: 'server', describe: 'Do not watch for artifacts change - only listen for transactions', demandOption: false })
            .option('l', { alias: 'local', describe: 'Do not listen for transactions - only watch contracts', demandOption: false })
    }, listen)
    .command('sync', 'Sync a block range', (yargs) => {
        return yargs
            .option('f', { alias: 'from', describe: 'Starting block', type: 'integer', demandOption: true })
            .option('t', { alias: 'to', describe: 'Ending block (included)', type: 'integer', demandOption: true })
    }, syncBlockRange)
    .argv;

let user, rpcServer, rpcProvider;
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
        await setupProvider();
        subscribe();
    }
}

async function setupProvider() {
    rpcServer = new URL(db.workspace.rpcServer);
    var urlInfo;
    var provider = ethers.providers.WebSocketProvider;
    
    if (rpcServer.username != '' && rpcServer.password != '') {
        urlInfo = {
            url: `${rpcServer.origin}${rpcServer.pathName ? rpcServer.pathName : ''}`,
            user: rpcServer.username,
            password: rpcServer.password
        };
    }
    else {
        urlInfo = rpcServer.href;
    }

    if (rpcServer.protocol == 'http:' || rpcServer.protocol == 'https:') {
        provider = ethers.providers.JsonRpcProvider;
    }
    else if (rpcServer.protocol == 'ws:' || rpcServer.protocol == 'wss:') {
        provider = ethers.providers.WebSocketProvider;
    }

    rpcProvider = new provider(urlInfo);
}

async function subscribe() {
    rpcProvider.on('block', onData);
    rpcProvider.on('error', onError);
    rpcProvider.on('pending', onPending);
    if (options.server) {
        console.log('Server option activated - only listening to transactions');
    }
    else {
        watchDirectories();
    }
}

function onPending() {
    //TODO: Implement
}

function watchDirectories() {
    var workingDirectories = options.dir ? options.dir : ['.'];
    workingDirectories.forEach((dir) => {
        var projectConfig = getProjectConfig(dir);
        if (projectConfig) {
            var projectType = projectConfig.truffle_directory ? 'Truffle' : 'Unknown';
            console.log(`Detected ${projectType} project for ${projectConfig.working_directory}`)
            if (projectType == 'Truffle') {
                watchTruffleArtifacts(dir, projectConfig);
            }
        }
    });
}

function onData(blockNumber, error) {
    if (error && error.reason) {
        return console.log(`Error while receiving data: ${error.reason}`);
    }

    rpcProvider.getBlockWithTransactions(blockNumber).then(syncBlock);
}

function onError(error) {
    if (error && error.reason) {
        console.log(`Could not connect to ${rpcServer}. Error: ${error.reason}`);
    }
    else {
        console.log(`Could not connect to ${rpcServer}.`);
    }
    console.log('Trying to reconnect in 5s...');
    setTimeout(connect, 5 * 1000);
}

function getProjectConfig(dir) {
    if (!dir) {
        console.log('Please specify a directory to check.');
        return;
    }
    var truffleConfigPath = path.format({
        dir: dir
    });

    var hardhatConfigPath = path.format({
        dir: dir,
        base: 'hardhat.config.js'
    });

    try {
        return TruffleConfig.detect({ workingDirectory: truffleConfigPath });
    } catch(e) {
        console.log(`${dir} does not contain a truffle-config.js file, contracts metadata won't be uploaded automatically.`);
        var isHardhatProject = fs.existsSync(hardhatConfigPath);
        if (isHardhatProject) {
            console.log(`${dir} appears to be a Hardhat project, if you are looking to synchronize contracts metadata, please look at our dedicated plugin here: https://github.com/tryethernal/hardhat-ethernal.`);
        }
        return false;
    }
}

function updateContractArtifact(contract) {
    if (!contract) {
        return;
    }

    var storeArtifactPromise = firebase.functions.httpsCallable('syncContractArtifact')({
        workspace: db.workspace.name,
        address: contract.address,
        artifact: contract.artifact
    });
    var storeDependenciesPromise = firebase.functions.httpsCallable('syncContractDependencies')({
        workspace: db.workspace.name,
        address: contract.address,
        dependencies: contract.dependencies
    });

    Promise.all([storeArtifactPromise, storeDependenciesPromise]).then(() => {
        firebase.functions.httpsCallable('syncContractData')({
            workspace: db.workspace.name,
            name: contract.name,
            address: contract.address,
            abi: contract.abi
        })
        .then(() => {
            const dependencies = Object.entries(contract.dependencies).map(art => art[0]);
            const dependenciesString = dependencies.length ? ` Dependencies: ${dependencies.join(', ')}` : '';
            console.log(`Updated artifacts for contract ${contract.name} (${contract.address}).${dependenciesString}`);
        });
    });
}

function watchTruffleArtifacts(dir, projectConfig) {
    if (!dir) {
        console.log('Please specify a directory to watch.');
        return;
    }
    
    const artifactsDir = projectConfig.contracts_build_directory;

    const watcher = chokidar.watch('.', { cwd: artifactsDir })
        .on('add', (path) => {
            updateContractArtifact(getTruffleArtifact(artifactsDir, path));
        })
        .on('change', (path) => {
            updateContractArtifact(getTruffleArtifact(artifactsDir, path));
        });
}

function getTruffleArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var contract;
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
    return contract;
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
    const promises = [];
    if (block) {
        promises.push(firebase.functions.httpsCallable('syncBlock')({ block: block, workspace: db.workspace.name }).then(({data}) => console.log(`Synced block #${data.blockNumber}`)));
        for (var i = 0; i < block.transactions.length; i++) {
            const transaction = block.transactions[i]
            rpcProvider.getTransactionReceipt(transaction.hash).then(receipt => {
                promises.push(syncTransaction(block, transaction, receipt));
            });
        }
    }
    return Promise.all(promises);
}
    
function syncTransaction(block, transaction, transactionReceipt) {
    return firebase.functions.httpsCallable('syncTransaction')({
        block: block,
        transaction: transaction,
        transactionReceipt: transactionReceipt,
        workspace: db.workspace.name
    }).then(({data}) => console.log(`Synced transaction ${data.txHash}`));
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
    var currentUser = await db.currentUser().get();
    var defaultWorkspace = await currentUser.data().currentWorkspace.get();
    return { ...defaultWorkspace.data(), name: defaultWorkspace.id };
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

async function setupWorkspace() {
    user = await login();
    if (!user) {
        process.exit(1);
    }
    console.log(`Logged in with ${await credentials.getEmail()}`);

    await setWorkspace();
}

async function listen() {
    await setupWorkspace();
    connect();
}

async function syncBlockRange() {
    await setupWorkspace();
    await setupProvider();

    const from = options.from;
    const to = options.to;
    if (from >= to) {
        console.log('"to" must be greater than "from".');
        process.exit(1);
    }

    const promises = [];
    for (var i = from; i <= to; i++)
        promises.push(rpcProvider.getBlockWithTransactions(i).then(syncBlock));

    Promise.all(promises).then(() => process.exit(0));

}

