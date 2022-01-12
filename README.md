# ethernal-cli

CLI to sync transactions with [Ethernal](https://www.tryethernal.com).

Truffle & Brownie artifacts are also synced through this CLI, if you are using Hardhat, use [this plugin](https://github.com/antoinedc/hardhat-ethernal).

If you are looking for more detailed doc about Ethernal: https://doc.tryethernal.com

## Installation

### OSX / Windows
```bash
npm install ethernal -g
```

### Linux
On Linux systems, Ethernal CLI relies on libsecret to securely store your password.
Make sure it's installed by running the following command, depending on your distribution:
- Debian/Ubuntu: sudo apt-get install libsecret-1-dev
- Red Hat-based: sudo yum install libsecret-devel
- Arch Linux: sudo pacman -S libsecret

[Source](https://github.com/atom/node-keytar#on-linux)

Then run:
```bash
npm install ethernal -g
```

## Usage

### Login
First, you need to login using your Ethernal credentials (only needed once).
```bash
ethernal login
```

Otherwise, you can pass the env variables ETHERNAL_EMAIL and ETHERNAL_PASSWORD to any of the commands below. This is especially useful if you are running Ethernal on Ubuntu or in a Docker container as you might run into issues with the keychain on there.

### Listening to transactions
This will synchronize blocks, transactions & contracts to Ethernal
The CLI will connect to the URL set on the workspace you used last.
```bash
ethernal listen
```
For blocks & transactions, the whole object returned by web3 is synchronized with Ethernal.

__Options__

### -w
Connect to the specified workspace
```bash
ethernal listen -w workspace
```

### -d
Specifiy which directory to watch (one or more, separated by a comma)
```bash
ethernal listen -d ~/solidity/project,~/solidity/project2
```

### -s
Only listen to transactions, do not watch artifacts for changes. Useful if your blockchain is not on your local environment.
Will be ignore if the ```-l``` flag is passed
```bash
ethernal listen -s
```

### -l
Only watch artifact changes, do not listen to transactions. Useful if you ran the ```ethernal listen -s``` somewhere else.
```bash
ethernal listen -l
```

### -h
Display help
```bash
ethernal listen -h
```

### Artifacts Uploading
Running the ```listen``` command in a Truffle or Brownie project will automatically watch your artifacts, and upload the data everytime it changes.
You can also pass a path to watch with the ```-d``` flag.
```bash
ethernal listen -d ~/solidity/my-project
```
Watch multiple directories at once:
```bash
ethernal listen -d ~/solidity/my-project,~/solidity/other-project
```

The CLI will watch artifacts in your build folder, and synchronize the following fields:
- contractName
- abi
- ast
- source

For Brownie projects, the flag ```dev_deployment_artifacts``` needs to be set to ```true``` in ```brownie-config.yaml```.

### Syncing a range of blocks

This will sync all blocks in a range (start and end of the range included), and their transactions. It takes two mandatory parameters: ```-f``` or ```--from``` is the first block to be synchronized, and ```-t``` or ```--to``` which is the last block.
```bash
ethernal sync -f 1 -t 10
```

### Resetting a workspace

This will delete all accounts/blocks/transactions/contracts from a specific workspace
```bash
ethernal reset [workspace]
```
