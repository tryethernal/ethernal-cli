#!/usr/bin/env node

const axios = require('axios');
const yargs = require('yargs');
const { sep } = require('path');
const ethers = require('ethers');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const firebase = require('../firebase');
const credentials = require('../credentials');
const inquirer = require('../inquirer');
const yaml = require('js-yaml');
const TruffleConfig = require('@truffle/config');
const solc = require('solc');
const linker = require('solc/linker');
const { parseTrace } = require('../tracer');

const options = yargs
    .command('login', 'Login to your Ethernal account', {}, setLogin)
    .command('listen', 'Start listening for transactions', (yargs) => {
        return yargs
            .option('w', { alias: 'workspace', describe: 'Workspace to connect to', type: 'string', demandOption: false })
            .option('d', { alias: 'dir', type: 'array', describe: 'Project directory to watch', demandOption: false })
            .option('s', { alias: 'server', describe: 'Do not watch for artifacts change - only listen for transactions. For this to work, the chain needs to be accessible from anywhere as the backend is going to query the data, not this CLI', demandOption: false })
            .option('l', { alias: 'local', describe: 'Do not listen for transactions - only watch contracts', demandOption: false })
            .option('a', { alias: 'astUpload', describe: 'Upload AST to decode storage', demandOption: false })
    }, listen)
    .command('sync', 'Sync a block range', (yargs) => {
        return yargs
            .option('s', { alias: 'server', describe: 'Sync blocks server side', demandOption: false })
            .option('f', { alias: 'from', describe: 'Starting block', type: 'integer', demandOption: true })
            .option('t', { alias: 'to', describe: 'Ending block (included)', type: 'integer', demandOption: true })
            .option('w', { alias: 'workspace', describe: 'Workspace to connect to.', type: 'string', demandOption: false })
    }, syncBlockRange)
    .command('reset [workspace]', 'Reset a workspace', (yargs) => {
        return yargs.positional('workspace', { describe: 'Workspace to reset' })
    }, resetWorkspace)
    .command('verify', 'Verify a contract', (yargs) => {
        return yargs
            .option('s', { alias: 'slug', describe: "Slug of the explorer to connect to", type: 'string', demandOption: true })
            .option('a', { alias: 'address', describe: 'Address of the contract to verify', type: 'string', demandOption: true })
            .option('c', { alias: 'compiler', describe: 'Solidity compiler version to use', type: 'string', demandOption: true })
            .option('n', { alias: 'name', describe: 'Name of the contract to verify', type: 'string', demandOption: true })
            .option('p', { alias: 'path', describe: 'Path to the file containing the contract to verify', type: 'string', demandOption: true })
            .option('l', { alias: 'libraries', describe: 'Link external library. Format path/to/library.sol:Library1=0x1234,path/to/library.sol:Library2=0x12345', type: 'string' })
            .option('g', { alias: 'constructorArguments', describe: 'Specify constructor arguments (ABI encoded)', type: 'string' })
            .option('e', { alias: 'evmVersion', describe: 'Specify EVM version (see https://docs.soliditylang.org/en/v0.8.16/using-the-compiler.html#target-options for valid options). Default to latest', type: 'string' })
            .option('o', { alias: 'optimizer', describe: 'Enable optimizer. Default to false', type: 'boolean' })
            .option('r', { alias: 'runs', describe: 'Number of runs if optimizer is enabled', type: 'number' })
    }, verifyContract).argv;

let user, rpcProvider;
let contractAddresses = {};
let db = new firebase.DB();

const API_ROOT = process.env.API_ROOT || 'https://app-pql6sv7epq-uc.a.run.app';

function verifyContract() {
    try {
        const options = arguments['0'];

        console.log(`Loading compiler (${options.compiler})...`);
        solc.loadRemoteVersion(options.compiler, (err, solc) => {
            const imports = {};
            const inputs = {
                language: 'Solidity',
                sources: {
                    [options.path]: {
                        content: fs.readFileSync(options.path).toString()
                    }
                },
                settings: {
                    outputSelection: {
                       '*': { '*': ['evm.bytecode.object'] }
                    },
                    optimizer: {
                        enabled: options.optimizer,
                        runs: options.runs
                    },
                    evmVersion: options.evmVersion
                }
            };

            function findImports(importPath) {
                try {
                    const relativePath = path.relative(importPath, '.');
                    const content = fs.readFileSync(relativePath).toString();
                    imports[relativePath] = { contents: content };
                    return imports[importPath];
                } catch(error) {
                    if (importPath.startsWith('https:')) {
                        console.log(`Error with import ${importPath}: remote import are not supported`);
                        process.exit(1);
                    }
                    const content = fs.readFileSync(`node_modules${sep}${importPath}`).toString();
                    imports[importPath] = { contents: content };
                    return imports[importPath];
                }
            }

            console.log('Compiling locally...');
            const compiledCode = JSON.parse(solc.compile(JSON.stringify(inputs), { import: findImports }));
            if (compiledCode.errors) {
                for (let error of compiledCode.errors)
                    console.log(error.formattedMessage)
            }

            const formattedLibraries = {};
            if (options.libraries) {
                try {
                    const libraries = options.libraries.split(',');
                    if (libraries.length > 0) {
                        libraries.map((library) => {
                            const split = library.split('=');
                            formattedLibraries[split[0]] = split[1];
                        });
                        linker.linkBytecode(compiledCode.contracts[options.path][options.name].evm.bytecode.object, formattedLibraries);
                    }
                } catch (error) {
                    console.log(`Invalid libraries path option, should be: path/to/library.sol:Library.sol=0x1234,path/to/library.sol:Library2.sol:0x12345.`);
                    process.exit(1);
                }
            }

            const constructorArguments = options.constructorArguments && options.constructorArguments.startsWith('0x') ? options.constructorArguments.slice(2) : options.constructorArguments;
            console.log('Starting verification...');
            const data = {
                explorerSlug: options.slug,
                compilerVersion: options.compiler,
                code: {
                    sources: {
                        [options.path]: {
                            content: fs.readFileSync(options.path).toString()
                        }
                    },
                    imports: imports,
                    libraries: formattedLibraries
                },
                contractName: options.name,
                constructorArguments: constructorArguments,
                evmVersion: options.evmVersion,
                optimizer: options.optimizer,
                runs: options.runs
            };

            axios.post(`${API_ROOT}/api/contracts/${options.address}/verify`, data)
                .then(() => console.log('Verification succeded!'))
                .catch(({ response: { data }}) => console.log(`Verification failed: ${data}`))
                .finally(() => process.exit(0));
        });
    } catch (error) {
        if (error.message)
            console.log(error.message);
        else
            console.log(error);
        process.exit(1);
    }
}

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
    const rpcServer = new URL(db.workspace.rpcServer);

    let provider = ethers.providers.WebSocketProvider;

    if (rpcServer.protocol == 'http:' || rpcServer.protocol == 'https:') {
        provider = ethers.providers.JsonRpcProvider;
    }
    else if (rpcServer.protocol == 'ws:' || rpcServer.protocol == 'wss:') {
        provider = ethers.providers.WebSocketProvider;
    }

    rpcProvider = new provider(db.workspace.rpcServer);
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
            var projectType = projectConfig.project_type;
            console.log(`Detected ${projectType} project for ${path.resolve(dir)}`)
            if (projectType == 'Truffle') {
                watchTruffleArtifacts(dir, projectConfig);
            } else if (projectType == 'Brownie') {
                if (!config.dev_deployment_artifacts) {
                    console.log("Notice: If developing locally make sure to set dev_deployment_artifacts to true in brownie-config.yaml");
                }
                watchBrownieArtifacts(dir, projectConfig);
            }
        }
    });
}

function onData(blockNumber, error) {
    if (error && error.reason) {
        return console.log(`Error while receiving data: ${error.reason}`);
    }
    console.log(`Syncing block #${blockNumber}...`);
    if (options.server)
        firebase.functions
            .httpsCallable('serverSideBlockSync')({ blockNumber: blockNumber, workspace: db.workspace.name })
            .catch(console.log);
    else
        rpcProvider.getBlockWithTransactions(blockNumber).then(syncBlock);
}

function onError(error) {
    if (error && error.reason) {
        console.log(`Could not connect to ${db.workspace.rpcServer}. Error: ${error.reason}`);
    }
    else {
        console.log(`Could not connect to ${db.workspace.rpcServer}.`);
    }
    process.exit(1);
}

function getProjectConfig(dir) {
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

    var brownieConfigPath = path.format({
        dir: dir,
        base: 'brownie-config.yaml'
    });

    var config;
    if (fs.existsSync(truffleConfigPath)) {
        config = TruffleConfig.detect({ workingDirectory: truffleConfigPath });
        config.project_type = 'Truffle';
    }
    else if (fs.existsSync(brownieConfigPath)) {
        config = yaml.load(fs.readFileSync(brownieConfigPath, 'utf8'));
        config.project_type = 'Brownie';
    }
    else if (fs.existsSync(hardhatConfigPath)) {
        console.log(`${dir} appears to be a Hardhat project, if you are looking to synchronize contracts metadata, please look at our dedicated plugin here: https://github.com/tryethernal/hardhat-ethernal.`);
    }
    else {
        console.log(`${dir} does not appear to be a Truffle or Brownie project, contracts metadata won't be uploaded automatically.`);
        return false;
    }

    return config;
}

function updateContractArtifact(contract) {
    if (!contract) {
        return;
    }

    const dependenciesPromises = [];

    if (options.astUpload) {
        console.log('Uploading contract & dependencies ASTs, this might take a while depending on the size of your contracts.')
        var storeArtifactPromise = firebase.functions.httpsCallable('syncContractArtifact')({
            workspace: db.workspace.name,
            address: contract.address,
            artifact: contract.artifact
        });

        for (const dep in contract.dependencies) {
            dependenciesPromises.push(
                    firebase.functions.httpsCallable('syncContractDependencies')({
                        workspace: db.workspace.name,
                        address: contract.address,
                        dependencies: { [dep]: contract.dependencies[dep] }
                    }).then(console.log)
            );
        }
    }

    Promise.all([storeArtifactPromise, ...dependenciesPromises]).then(() => {
        firebase.functions.httpsCallable('syncContractData')({
            workspace: db.workspace.name,
            name: contract.name,
            address: contract.address,
            abi: contract.abi
        })
        .then(() => {
            const dependencies = Object.entries(contract.dependencies).map(art => art[0]);
            const dependenciesString = dependencies.length && options.astUpload ? ` Dependencies: ${dependencies.join(', ')}` : '';
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

    const watcher = chokidar.watch('./*.json', { cwd: artifactsDir })
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

function watchBrownieArtifacts(dir, projectConfig) {
    if (!dir) {
        console.log('Please specify a directory to watch.');
        return;
    }
    // Might need to add a way to specify which deployment folder to watch
    const artifactsDir = path.format({
        dir: dir,
        base: "build/deployments"
    }); 
    const watcher = chokidar.watch('./**/*.json', { cwd: artifactsDir, ignored: 'map.json' })
        .on('add', (path) => {
            updateContractArtifact(getBrownieArtifact(artifactsDir, path));
        })
        .on('change', (path) => {
            updateContractArtifact(getBrownieArtifact(artifactsDir, path));
        });
}

function getBrownieArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var contract;
    var rawArtifact = fs.readFileSync(path.format({ dir: artifactsDir, base: fileName }), 'utf8');
    var parsedArtifact = JSON.parse(rawArtifact);

    var contractAddress = parsedArtifact.deployment ? parsedArtifact.deployment.address : null;
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
    if (block) {
        firebase.functions.httpsCallable('syncBlock')({ block: block, workspace: db.workspace.name })
            .then(({data}) => {
                console.log(`Synced block #${data.blockNumber}`) 
                for (var i = 0; i < block.transactions.length; i++) {
                    const transaction = block.transactions[i]
                    rpcProvider.getTransactionReceipt(transaction.hash).then(receipt => {
                        syncTransaction(block, transaction, receipt)
                            .then(({ data }) => {
                                console.log(`Synced transaction ${data.txHash}`);
                                if (shouldSyncTrace())
                                    traceTransaction(transaction)
                                        .then(() => console.log(`Synced trace for tx ${transaction.hash}`))
                                        .catch(console.log);
                            });
                        if (!receipt) {
                            console.log(`Couldn't get receipt information for tx #${transaction.hash}.`);
                        }
                    });
                }
            });
    }
}

function shouldSyncTrace() {
    return currentWorkspace &&
        currentWorkspace.advancedOptions &&
        currentWorkspace.advancedOptions.tracing == 'other';
}
    
function syncTransaction(block, transaction, transactionReceipt) {
    return firebase.functions.httpsCallable('syncTransaction')({
        block: block,
        transaction: transaction,
        transactionReceipt: transactionReceipt,
        workspace: db.workspace.name
    })
}

async function traceTransaction(transaction) {
    try {
        const trace = await rpcProvider.send('debug_traceTransaction', [transaction.hash, {}]).catch(() => null);

        const parsedTrace = await parseTrace(transaction.to, trace, rpcProvider);
        return firebase.functions.httpsCallable('syncTrace')({
            workspace: db.workspace.name,
            txHash: transaction.hash,
            steps: parsedTrace
        });
    } catch(error) {
        if (error.error && error.error.code == '-32601')
            console.log('debug_traceTransaction is not available');
        else
            console.log(error);
    }
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

    const from = options.from;
    const to = options.to;
    if (from >= to) {
        console.log('"to" must be greater than "from".');
        process.exit(1);
    }

    if (options.server) {
        console.log('Queuing blocks syncing...');
        await firebase.functions.httpsCallable('resyncBlocks')({ workspace: options.workspace, fromBlock: options.from, toBlock: options.to })
        console.log('Blocks syncing queued succesfully, they will appear on the dashboard soon!');
        process.exit(0);
    }
    else {
        await setupProvider();
        const promises = [];
        for (var i = from; i <= to; i++)
            promises.push(rpcProvider.getBlockWithTransactions(i).then(syncBlock));

        Promise.all(promises).then(() => process.exit(0));
    }
}

async function resetWorkspace(argv) {
    await login();

    const workspace = argv.workspace;
    console.log(`Resetting workspace "${workspace}"...`);
    try {
        await firebase.functions.httpsCallable('resetWorkspace')({ workspace: workspace });
        console.log('Done!')
        process.exit(0)
    } catch(error) {
        console.log(`Error while resetting workspace: ${error.message}`);
        process.exit(1);
    }
};
