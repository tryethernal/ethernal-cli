const inquirer = require('inquirer');

module.exports = {
    login: () => {
        const questions = [
            {
                name: 'email',
                type: 'input',
                message: 'Email:',
                validate: function(value) {
                    if (value.length) return true;
                    else return 'Please enter the email address you used to sign up on Ethernal.';
                }
            },
            {
                name: 'password',
                type: 'password',
                message: 'Password (will be securely stored in your local keychain):',
                validate: function(value) {
                    if (value.length) return true;
                    else return 'Please enter your password.';
                }
            }
        ];
        return inquirer.prompt(questions);
    }
};