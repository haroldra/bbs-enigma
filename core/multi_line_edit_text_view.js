/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');

var assert			= require('assert');
var _				= require('lodash');
var GapBuffer		= require('gapbuffer').GapBuffer;

//
//	Notes
//	* options.tabSize can be used to resolve \t
//	* See https://github.com/dominictarr/hipster/issues/15 about insert/delete lines
//
//	Blessed
//		insertLine: CSR(top, bottom) + CUP(y, 0) + IL(1) + CSR(0, height)
//		deleteLine: CSR(top, bottom) + CUP(y, 0) + DL(1) + CSR(0, height)
//	Quick Ansi -- update only what was changed:
//	https://github.com/dominictarr/quickansi
//
//	This thread is awesome:
//	https://github.com/dominictarr/hipster/issues/15
//
//	See Atom's implementations
//	Newer TextDocument
//		https://github.com/atom/text-document
//
//	Older TextBuffer
//		http://www.oscon.com/oscon2014/public/schedule/detail/37593
//
//	Span Skip List could be used for mappings of rows/cols (display) to
//	character offsets in a buffer
//		https://github.com/atom/span-skip-list

//
//	Buffer: Actual text buffer
//	Transform: Display of soft wrap & tab expansion (e.g. tab -> ' ' * tabWidth)
//

//
//	General Design
//	
//	*	Take any existing input & word wrap into lines[] preserving
//		formatting characters.
//	*	When drawing, formatting characters are processed but not shown
//		or processed directly in many cases. E.g., \n is processed but simply
//		causes us to go to our "next line" visibly.
//	*	Empty/blank lines = \n
//
exports.MultiLineEditTextView	= MultiLineEditTextView;

//
//	Some resources & comparisons
//	
//	Enthral @ https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//		* Tabs are ignored
//		* Preview/reading mode processes colors, otherwise just text (e.g. editor)
//	
//	x84 @ https://github.com/jquast/x84/blob/master/x84/bbs/editor.py
//
//	Syncronet
//
//
//	Projects of use/interest:
//
//	https://github.com/atom/text-buffer
//	http://danieltao.com/lazy.js/
//	http://www.jbox.dk/downloads/edit.c
//	https://github.com/slap-editor/slap
//	https://github.com/chjj/blessed
//

function MultiLineEditTextView(options) {
	
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	View.call(this, options);

	//
	//	defualt tabWidth is 4
	//	See the following:
	//	* http://www.ansi-bbs.org/ansi-bbs2/control_chars/
	//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//
	this.tabWidth	= _.isNumber(options.tabWidth) ? options.tabWidth : 8;


	var self = this;

	this.renderBuffer	= [];
	this.textBuffer		= new GapBuffer(1024);

	this.lines			= [];				//	a given line is text...until EOL
	this.topLineIndex	= 0;
	this.cursorPos		= { x : 0, y : 0 };	//	relative to view window
	this.renderStartIndex	= 0;

	/*
	this.redrawViewableText = function() {
		//
		//	v--- position.row/y
		//	+-----------------------------------+ <--- x + width
		//	|                                   |
		//	|                                   |
		//	|                                   |
		//	+-----------------------------------+
		//	^--- position.row + height
		//
		//	A given line in lines[] may need to take up 1:n physical lines
		//	due to wrapping / available space.
		//
		var x		= self.position.row;
		var bottom	= x + self.dimens.height;
		var idx		= self.topLineIndex;

		self.client.term.write(self.getSGR());

		var lines;
		while(idx < self.lines.length && x < bottom) {
			if(0 === self.lines[idx].length) {
				++x;
			} else {
				lines = self.wordWrap(self.lines[idx]);
				for(var y = 0; y < lines.length && x < bottom; ++y) {
					self.client.term.write(ansi.goto(x, this.position.col));
					self.client.term.write(lines[y]);
					++x;
				}
			}

			++idx;
		}
	};
	*/

	/*
	this.createScrollRegion = function() {
		self.client.term.write(ansi.setScrollRegion(self.position.row, self.position.row + 5));//self.dimens.height));
	};
	*/

	this.getTabString = function() {
		return new Array(self.tabWidth).join(' ');
	};

	this.redrawViewableText = function() {
		var row		= self.position.row;
		var bottom	= row + self.dimens.height;
		var i		= self.topLineIndex;

		self.client.term.write(self.getSGR());

		while(i < self.renderBuffer.length && row < bottom) {
			self.client.term.write(ansi.goto(row, this.position.col));
			self.client.term.write(self.renderBuffer[i]);
			++row; 
			++i;
		}
	};

	this.wordWrap = function(line) {
		//
		//	Other implementations:
		//	* http://blog.macromates.com/2006/wrapping-text-with-regular-expressions/
		//	* http://james.padolsey.com/snippets/wordwrap-for-javascript/
		//	* http://phpjs.org/functions/wordwrap/
		//	* https://github.com/jonschlinkert/word-wrap
		//
		var re = new RegExp(
			'.{1,' + self.dimens.width + '}(\\s+|$)|\\S+?(\\s+|$)', 'g');
		return line.match(re) || [];
	};

	this.wordWrap2 = function(line) {
		var tabString = self.getTabString();
		var re = new RegExp(
			'.{1,' + self.dimens.width + '}(\\s+|$)|\\S+?(\\s+|$)', 'g');
		var checkLine = line.replace(/\t/g, tabString);
	};

	this.regenerateRenderBuffer = function() {
		self.renderBuffer = [];

		//	:TODO: optimize this by only rending what is visible -- or at least near there, e.g. topindex -> maxchars that can fit at most

		//	:TODO: asArray() should take a optional scope, e.g. asArray(beg, end)
		var lines = self.textBuffer.asArray().slice(self.renderStartIndex)
			.join('')
			//.replace(/\t/g, self.tabString)
			.split(/\r\n|\n|\r/g);

		var maxLines = self.dimens.height - self.position.row;
		
		for(var i = 0; i < lines.length && self.renderBuffer.length < maxLines; ++i) {
			if(0 === lines[i].length) {
				self.renderBuffer.push('');
			} else {
				Array.prototype.push.apply(self.renderBuffer, self.wordWrap(lines[i]));
			}
		}
	};

	this.getTextBufferPosition = function(row, col) {
		
	};
	
	this.scrollUp = function(count) {

	};

	this.scrollDown = function(count) {

	};

	this.cursorUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			console.log(self.lines[self.getLineIndex()])
		} else if(self.topLineIndex > 0) {
			//	:TODO: scroll 
		}



		//	:TODO: if there is text @ cursor y position we're ok, otherwise,
		//	jump to the end of the line
	};

	this.getLineIndex = function() {
		return self.topLineIndex + self.cursorPos.row;
	};

}

require('util').inherits(MultiLineEditTextView, View);

MultiLineEditTextView.prototype.setPosition = function(pos) {
	MultiLineEditTextView.super_.prototype.setPosition.call(this, pos);

	
};

MultiLineEditTextView.prototype.redraw = function() {
	MultiLineEditTextView.super_.prototype.redraw.call(this);

	this.redrawViewableText();
	//this.client.term.write(this.text);
};

/*MultiLineEditTextView.prototype.setFocus = function(focused) {

	MultiLineEditTextView.super_.prototype.setFocus.call(this, focused);
};
*/

MultiLineEditTextView.prototype.setText = function(text) {
	//this.cursorPos.row = this.position.row + this.dimens.height;
	//this.lines = this.wordWrap(text);

	if(this.textBuffer.length > 0) {	//	:TODO: work around GapBuffer bug: if it's already empty this will cause gapEnd to be undefined
		this.textBuffer.clear();
	}

	//this.textBuffer.insertAll(0, text);
	text = text.replace(/\b/g, '');

	this.textBuffer.insertAll(0, text);

	/*
	var c;
	for(var i = 0; i < text.length; ++i) {
		c = text[i];

		//	:TODO: what should really be removed here??? Any non-printable besides \t and \r\n?
		if('\b' === c) {
			continue;
		}

		this.textBuffer.insert(i, c);
	}*/

	this.regenerateRenderBuffer();

	console.log(this.renderBuffer)
}

MultiLineEditTextView.prototype.onSpecialKeyPress = function(keyName) {
	if(this.isSpecialKeyMapped('up', keyName)) {
		this.cursorUp();
	} else if(this.isSpecialKeyMapped('down', keyName)) {

	} else if(this.isSpecialKeyMapped('left', keyName)) {

	} else if(this.isSpecialKeyMapped('right', keyName)) {

	}

	MultiLineEditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
}