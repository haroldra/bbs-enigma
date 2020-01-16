/* jslint node: true */
'use strict';

//	ENiGMA½
var conf		= require('../config.js');
var baseClient	= require('../client.js');
var user		= require('../user.js');

var ssh2			= require('ssh2');
var fs				= require('fs');

exports.moduleInfo = {
	name	: 'SSH',
	desc	: 'SSH Server',
	author	: 'NuSkooler'
};

exports.createServer	= createServer;

function SSHClient(input, output) {
	baseClient.Client.apply(this, arguments);

	var self = this;

	this.input.on('authentication', function onAuthentication(ctx) {
		console.log('auth: ' + ctx.method);

		if('password' == ctx.method) {
			//	:TODO: Log attempts
			user.authenticate(ctx.username, ctx.password, self, function onAuthResult(isAuth) {
				if(isAuth) {
					ctx.accept();
				} else {
					ctx.reject();
				}
			});
		} else if('publickey' == ctx.method) {
			console.log('pub key path');
			//	:TODO: support this. Allow users to generate a key for use or w/e
		} else {
			ctx.reject();
		}
	});

	this.input.on('ready', function onReady() {
		console.log('Client authenticated');
	});

	this.input.on('session', function onSession(accept, reject) {
		var session = accept();
	});

	this.input.on('end', function onEnd() {
		self.emit('end');
	});
}

require('util').inherits(SSHClient, baseClient.Client);

function createServer() {
	//	:TODO: setup all options here. What should the banner, etc. really be????
	var serverConf = {
		privateKey : fs.readFileSync(conf.config.servers.ssh.rsaPrivateKey),
		banner : 'ENiGMA½ BBS SSH Server',
		debug : function onDebug(s) { console.log(s); }
	};

	var server = ssh2.Server(serverConf);
	server.on('connection', function onConnection(conn) {
		var client = new SSHClient(conn, conn);
		this.emit('client', client);
	});

	return server;
}
