/* jslint node: true */
'use strict';

var fs			= require('fs');
var paths		= require('path');
var miscUtil	= require('./misc_util.js');

//	:TODO: it would be nice to allow for defaults here & .json file only overrides -- e.g. merge the two

module.exports = {
	defaultPath		: function() {
		var base = miscUtil.resolvePath('~/');
		if(base) {
			return paths.join(base, '.enigmabbs', 'config.json');
		}
	},

	initFromFile	: function(path, cb) {
		var data	= fs.readFileSync(path, 'utf8');
		//	:TODO: strip comments
		this.config = JSON.parse(data);
	},

	createDefault	: function() {
		this.config = {
			bbsName		: 'Another Fine ENiGMA½ BBS',

			//	:TODO: probably replace this with 'firstMenu' or somthing once that's available
			entryMod	: 'matrix',
			
			preLoginTheme : '*',

			users : {
				usernameMin			: 2,
				usernameMax			: 22,
				passwordMin			: 6,
				requireActivation	: true,	//	require SysOp activation?
			},

			defaults : {
				theme			: 'NU-MAYA',
				passwordChar	: '*',
			},

			paths		: {
				mods				: paths.join(__dirname, './../mods/'),
				servers				: paths.join(__dirname, './servers/'),
				art					: paths.join(__dirname, './../mods/art/'),
				themes				: paths.join(__dirname, './../mods/art/themes/'),
				logs				: paths.join(__dirname, './../logs/'),	//	:TODO: set up based on system, e.g. /var/logs/enigmabbs or such
				db					: paths.join(__dirname, './../db/'),
			},
			
			servers : {
				telnet : {
					port			: 8888,
					enabled			: true,
				},
				ssh : {
					port			: 8889,
					enabled			: true,
					rsaPrivateKey	: paths.join(__dirname, './../misc/default_key.rsa'),
					dsaPrivateKey	: paths.join(__dirname, './../misc/default_key.dsa'),
				}
			},
		};
	}
};