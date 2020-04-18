/* jslint node: true */
'use strict';

var View			= require('./view.js').View;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var ansi			= require('./ansi_term.js');

var assert			= require('assert');
var _				= require('lodash');

//	:TODO: Determine CTRL-* keys for various things
	//	See http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//	http://wiki.synchro.net/howto:editor:slyedit#edit_mode
	//	http://sublime-text-unofficial-documentation.readthedocs.org/en/latest/reference/keyboard_shortcuts_win.html

	/* Mystic
	 [^B]  Reformat Paragraph            [^O]  Show this help file
       [^I]  Insert tab space              [^Q]  Enter quote mode
       [^K]  Cut current line of text      [^V]  Toggle insert/overwrite
       [^U]  Paste previously cut text     [^Y]  Delete current line


                            BASIC MOVEMENT COMMANDS

                  UP/^E       LEFT/^S      PGUP/^R      HOME/^F
                DOWN/^X      RIGHT/^D      PGDN/^C       END/^G
*/

//
//	Some other interesting implementations, resources, etc.
//
//	Editors - BBS
//	*	https://github.com/M-griffin/Enthral/blob/master/src/msg_fse.cpp
//
//	Editors - Other
//	*	http://joe-editor.sourceforge.net/
//	* 	http://www.jbox.dk/downloads/edit.c
//

//	Misc notes
//	* See https://github.com/dominictarr/hipster/issues/15 about insert/delete lines
//
//	Blessed
//		insertLine: CSR(top, bottom) + CUP(y, 0) + IL(1) + CSR(0, height)
//		deleteLine: CSR(top, bottom) + CUP(y, 0) + DL(1) + CSR(0, height)
//	Quick Ansi -- update only what was changed:
//	https://github.com/dominictarr/quickansi

//
//	To-Do
//	
//	* Index pos % for emit scroll events
//	* Some of this shoudl be async'd where there is lots of processing (e.g. word wrap)
//	* Fix backspace when col=0 (e.g. bs to prev line)


var SPECIAL_KEY_MAP_DEFAULT = {
	'line feed'		: [ 'return' ],
	exit			: [ 'esc' ],
	backspace		: [ 'backspace' ],
	'delete'		: [ 'del' ],
	tab				: [ 'tab' ],
	up				: [ 'up arrow' ],
	down			: [ 'down arrow' ],
	end				: [ 'end' ],
	home			: [ 'home' ],
	left			: [ 'left arrow' ],
	right			: [ 'right arrow' ],
	'delete line'	: [ 'ctrl + y' ],
	'page up'		: [ 'page up' ],
	'page down'		: [ 'page down' ],
	insert			: [ 'insert', 'ctrl + v' ],
};

exports.MultiLineEditTextView	= MultiLineEditTextView;

function MultiLineEditTextView(options) {
	if(!_.isBoolean(options.acceptsFocus)) {
		options.acceptsFocus = true;
	}

	if(!_.isBoolean(this.acceptsInput)) {
		options.acceptsInput = true;
	}

	if(!_.isObject(options.specialKeyMap)) {
		options.specialKeyMap = SPECIAL_KEY_MAP_DEFAULT;
	}

	View.call(this, options);

	var self = this;

	//
	//	ANSI seems to want tabs to default to 8 characters. See the following:
	//	* http://www.ansi-bbs.org/ansi-bbs2/control_chars/
	//	* http://www.bbsdocumentary.com/library/PROGRAMS/GRAPHICS/ANSI/bansi.txt
	//
	//	This seems overkill though, so let's default to 4 :)
	//
	this.tabWidth	= _.isNumber(options.tabWidth) ? options.tabWidth : 4;

	this.textLines			= [];
	this.topVisibleIndex	= 0;
	this.mode				= options.mode || 'edit';	//	edit | preview

	//
	//	cursorPos represents zero-based row, col positions
	//	within the editor itself
	//
	this.cursorPos			= { col : 0, row : 0 };

	this.getSGRFor = function(sgrFor) {
		return {
			text : self.getSGR(),
		}[sgrFor] || self.getSGR();
	};

	//	:TODO: Most of the calls to this could be avoided via incrementRow(), decrementRow() that keeps track or such
	this.getTextLinesIndex = function(row) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		var index = self.topVisibleIndex + row;
		return index;
	};

	this.getRemainingLinesBelowRow = function(row) {
		if(!_.isNumber(row)) {
			row = self.cursorPos.row;
		}
		return self.textLines.length - (self.topVisibleIndex + row) - 1;
	};

	this.getNextEndOfLineIndex = function(startIndex) {
		for(var i = startIndex; i < self.textLines.length; i++) {
			if(self.textLines[i].eol) {
				return i;
			}
		}
		return self.textLines.length;
	};

	this.redrawRows = function(startRow, endRow) {
		self.client.term.rawWrite(self.getSGRFor('text') + ansi.hideCursor());

		var startIndex	= self.getTextLinesIndex(startRow);
		var endIndex	= Math.min(self.getTextLinesIndex(endRow), self.textLines.length);
		var absPos		= self.getAbsolutePosition(startRow, 0);

		for(var i = startIndex; i < endIndex; ++i) {
			self.client.term.write(
				ansi.goto(absPos.row++, absPos.col) +
				self.getRenderText(i), false);
		}

		self.client.term.rawWrite(ansi.showCursor());

		return absPos.row - self.position.row;	//	row we ended on
	};

	this.eraseRows = function(startRow, endRow) {
		self.client.term.rawWrite(self.getSGRFor('text') + ansi.hideCursor());
	
		var absPos		= self.getAbsolutePosition(startRow, 0);
		var absPosEnd	= self.getAbsolutePosition(endRow, 0);
		var eraseFiller	= new Array(self.dimens.width).join(' ');

		while(absPos.row < absPosEnd.row) {
			self.client.term.write(
				ansi.goto(absPos.row++, absPos.col) +
				eraseFiller, false);
		}

		self.client.term.rawWrite(ansi.showCursor());
	};

	this.redrawVisibleArea = function() {
		assert(self.topVisibleIndex <= self.textLines.length);
		var lastRow = self.redrawRows(0, self.dimens.height);

		self.eraseRows(lastRow, self.dimens.height);
		/*

		//	:TOOD: create eraseRows(startRow, endRow)
		if(lastRow < self.dimens.height) {
			var absPos	= self.getAbsolutePosition(lastRow, 0);
			var empty	= new Array(self.dimens.width).join(' ');
			while(lastRow++ < self.dimens.height) {
				self.client.term.write(ansi.goto(absPos.row++, absPos.col));
				self.client.term.write(empty);
			}
		}
		*/
	};

	this.getVisibleText = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines[index].text.replace(/\t/g, ' ');	
	};

	this.getText = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines.length > index ? self.textLines[index].text : '';
	};

	this.getTextLength = function(index) {
		if(!_.isNumber(index)) {
			index = self.getTextLinesIndex();
		}
		return self.textLines.length > index ? self.textLines[index].text.length : 0;
	};

	this.getCharacter = function(index, col) {
		if(!_.isNumber(col)) {
			col = self.cursorPos.col;
		}
		return self.getText(index).charAt(col);
	};

	this.isTab = function(index, col) {
		return '\t' === self.getCharacter(index, col);
	};

	this.getTextEndOfLineColumn = function(index) {
		return Math.max(0, self.getTextLength(index));
	};

	this.getRenderText = function(index) {
		var text = self.getVisibleText(index);
		var remain	= self.dimens.width - text.length;
		if(remain > 0) {
			text += new Array(remain + 1).join(' ');
		}
		return text;
	};

 	this.getTextLines = function(startIndex, endIndex) {
 		var lines;
		if(startIndex === endIndex) {
			lines = [ self.textLines[startIndex] ];
		} else {
			lines = self.textLines.slice(startIndex, endIndex + 1);	//	"slice extracts up to but not including end."
		}
		return lines;
 	};

	this.getOutputText = function(startIndex, endIndex, includeEol) {
		var lines = self.getTextLines(startIndex, endIndex);

		//
		//	Convert lines to contiguous string -- all expanded
		//	tabs put back to single '\t' characters.
		//
		var text = '';
		var re = new RegExp('\\t{1,' + (self.tabWidth) + '}', 'g');
		for(var i = 0; i < lines.length; ++i) {
			text += lines[i].text.replace(re, '\t');
			if(includeEol && lines[i].eol) {
				text += '\n';
			}
		}
		return text;
	};

	this.getContiguousText = function(startIndex, endIndex, includeEol) {
		var lines = self.getTextLines(startIndex, endIndex);
		var text = '';
		for(var i = 0; i < lines.length; ++i) {
			text += lines[i].text;
			if(includeEol && lines[i].eol) {
				text += '\n';
			}
		}
		return text;
	};

	this.replaceCharacterInText = function(c, index, col) {
		self.textLines[index].text = strUtil.replaceAt(
			self.textLines[index].text, col, c);
	};

	/*
	this.editTextAtPosition = function(editAction, text, index, col) {
		switch(editAction) {
			case 'insert' : 
				self.insertCharactersInText(text, index, col);
				break;

			case 'deleteForward' :
				break;

			case 'deleteBack' :
				break;

			case 'replace' :
				break;
		}
	};
	*/

	this.updateTextWordWrap = function(index) {
		var nextEolIndex	= self.getNextEndOfLineIndex(index);
		var wrapped			= self.wordWrapSingleLine(self.getContiguousText(index, nextEolIndex), 'tabsIntact');
		var newLines		= wrapped.wrapped;

		for(var i = 0; i < newLines.length; ++i) {
			newLines[i] = { text : newLines[i] };
		}
		newLines[newLines.length - 1].eol = true;

		Array.prototype.splice.apply(
			self.textLines, 
			[ index, (nextEolIndex - index) + 1 ].concat(newLines));

		return wrapped.firstWrapRange;
	};

	this.removeCharactersFromText = function(index, col, operation, count) {
		if('right' === operation) {
			self.textLines[index].text = 
				self.textLines[index].text.slice(col, count) +
				self.textLines[index].text.slice(col + count);

			self.cursorPos.col -= count;

			self.updateTextWordWrap(index);
			self.redrawRows(self.cursorPos.row, self.dimens.height);

			if(0 === self.textLines[index].text) {

			} else {
				self.redrawRows(self.cursorPos.row, self.dimens.height);
			}
		} else if ('backspace' === operation) {
			//	:TODO: method for splicing text
			self.textLines[index].text =
				self.textLines[index].text.slice(0, col - (count - 1)) + 
				self.textLines[index].text.slice(col + 1);

			self.cursorPos.col -= (count - 1);
			
			self.updateTextWordWrap(index);
			self.redrawRows(self.cursorPos.row, self.dimens.height);

			self.moveClientCusorToCursorPos();
		} else if('delete line' === operation) {
			//
			//	Delete a visible line. Note that this is *not* the "physical" line, or
			//	1:n entries up to eol! This is to keep consistency with home/end, and
			//	some other text editors such as nano. Sublime for example want to
			//	treat all of these things using the physical approach, but this seems
			//	a bit odd in this context.
			//
			var isLastLine	= (index === self.textLines.length - 1);
			var hadEol		= self.textLines[index].eol;

			self.textLines.splice(index, 1);
			if(hadEol && self.textLines.length > index && !self.textLines[index].eol) {
				self.textLines[index].eol = true;
			}

			//
			//	Create a empty edit buffer if necessary
			//	:TODO: Make this a method
			if(self.textLines.length < 1) {
				self.textLines = [ { text : '', eol : true } ];
				isLastLine = false;	//	resetting
			}

			self.cursorPos.col = 0;

			var lastRow = self.redrawRows(self.cursorPos.row, self.dimens.height);
			self.eraseRows(lastRow, self.dimens.height);

			//
			//	If we just deleted the last line in the buffer, move up
			//
			if(isLastLine) {
				self.cursorEndOfPreviousLine();
			} else {
				self.moveClientCusorToCursorPos();
			}
		}
	};

	this.insertCharactersInText = function(c, index, col) {
		self.textLines[index].text = [
				self.textLines[index].text.slice(0, col), 
				c, 
				self.textLines[index].text.slice(col)				
			].join('');

		//self.cursorPos.col++;
		self.cursorPos.col += c.length;

		var cursorOffset;
		var absPos;

		if(self.getTextLength(index) > self.dimens.width) {
			//console.log('textLen=' + self.getTextLength(index) + ' / ' + self.dimens.width + ' / ' +
			//	JSON.stringify(self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col)))

			//
			//	Update word wrapping and |cursorOffset| if the cursor
			//	was within the bounds of the wrapped text
			//
			var lastCol			= self.cursorPos.col - c.length;
			var firstWrapRange	= self.updateTextWordWrap(index);
			if(lastCol >= firstWrapRange.start && lastCol <= firstWrapRange.end) {
				cursorOffset = self.cursorPos.col - firstWrapRange.start;
			}

			//	redraw from current row to end of visible area
			self.redrawRows(self.cursorPos.row, self.dimens.height);

			if(!_.isUndefined(cursorOffset)) {
				//console.log('cursorOffset=' + cursorOffset)
				self.cursorBeginOfNextLine();
				self.cursorPos.col += cursorOffset;
				self.client.term.rawWrite(ansi.right(cursorOffset));
			} else {
				//console.log('this path')
				self.moveClientCusorToCursorPos();
				/*
				
				self.cursorPos.row++;
				self.cursorPos.col = 1;	//	we just added 1 char
				absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
				console.log('absPos=' + JSON.stringify(absPos))
				self.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
				*/
			}
		} else {
			//
			//	We must only redraw from col -> end of current visible line
			//
			//console.log('textLen=' + self.getTextLength(index))
			absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
			self.client.term.write(
				ansi.hideCursor() + 
				self.getSGRFor('text') +  
				self.getRenderText(index).slice(self.cursorPos.col - c.length) +
				ansi.goto(absPos.row, absPos.col) +
				ansi.showCursor(), false
				);
		}			
	};

	this.getRemainingTabWidth = function(col) {
		if(!_.isNumber(col)) {
			col = self.cursorPos.col;
		}
		return self.tabWidth - (col % self.tabWidth);
	};

	this.calculateTabStops = function() {
		self.tabStops = [ 0 ];
		var col = 0;
		while(col < self.dimens.width) {
			col += self.getRemainingTabWidth(col);
			self.tabStops.push(col);
		}
	};

	this.getNextTabStop = function(col) {
		var i = self.tabStops.length;
		while(self.tabStops[--i] > col);
		return self.tabStops[++i];
	};

	this.getPrevTabStop = function(col) {
		var i = self.tabStops.length;
		while(self.tabStops[--i] >= col);
		return self.tabStops[i];
	};

	this.expandTab = function(col, expandChar) {
		expandChar = expandChar || ' ';
		return new Array(self.getRemainingTabWidth(col)).join(expandChar);
	};

	this.wordWrapSingleLine = function(s, tabHandling, width) {
		tabHandling = tabHandling || 'expandTabs';
		if(!_.isNumber(width)) {
			width = self.dimens.width;
		}

		//
		//	Notes
		//	*	Sublime Text 3 for example considers spaces after a word
		//		part of said word. For example, "word    " would be wraped
		//		in it's entirity.
		//
		//	*	Tabs in Sublime Text 3 are also treated as a word, so, e.g.
		//		"\t" may resolve to "      " and must fit within the space.
		//
		//	*	If a word is ultimately too long to fit, break it up until it does.
		//
		//	RegExp below is JavaScript '\s' minus the '\t'
		//
		var re = new RegExp(
			'\t|[ \f\n\r\v​\u00a0\u1680​\u180e\u2000​\u2001\u2002​\u2003\u2004\u2005\u2006​' + 
			'\u2007\u2008​\u2009\u200a​\u2028\u2029​\u202f\u205f​\u3000]', 'g');
		var m;
		var wordStart = 0;
		var results = { wrapped : [ '' ] };
		var i = 0;
		var word;

		function addWord() {
			word.match(new RegExp('.{0,' + width + '}', 'g')).forEach(function wrd(w) {
				//console.log(word.match(new RegExp('.{0,' + (width - 1) + '}', 'g')))
				//if(results.wrapped[i].length + w.length >= width) {
				if(results.wrapped[i].length + w.length > width) {
					if(0 === i) {
						results.firstWrapRange = { start : wordStart, end : wordStart + w.length };
					}
					results.wrapped[++i] = w;
				} else {
					results.wrapped[i] += w;
				}
			});
		}

		while((m = re.exec(s)) !== null) {
			word = s.substring(wordStart, re.lastIndex - 1);

			switch(m[0].charAt(0)) {
				case ' ' :
					word += m[0];
				break;

				case '\t' :
					//
					//	Expand tab given position
					//
					//	Nice info here: http://c-for-dummies.com/blog/?p=424
					//
					if('expandTabs' === tabHandling) {
						word += self.expandTab(results.wrapped[i].length + word.length, '\t') + '\t';
					} else {
						word += m[0];
					}
				break;
			}

			addWord();
			wordStart = re.lastIndex + m[0].length - 1;
		}

		//
		//	Remainder
		//
		word = s.substring(wordStart);
		addWord();

		return results;
	};

	//	:TODO: rename to insertRawText()
	this.insertRawText = function(text, index, col) {
		//
		//	Perform the following on |text|:
		//	*	Normalize various line feed formats -> \n
		//	*	Remove some control characters (e.g. \b)
		//	*	Word wrap lines such that they fit in the visible workspace.
		//		Each actual line will then take 1:n elements in textLines[].
		//	*	Each tab will be appropriately expanded and take 1:n \t
		//		characters. This allows us to know when we're in tab space
		//		when doing cursor movement/etc.
		//
		//
		//	Try to handle any possible newline that can be fed to us.
		//	See http://stackoverflow.com/questions/5034781/js-regex-to-split-by-line
		//
		//	:TODO: support index/col insertion point

		if(_.isNumber(index)) {
			if(_.isNumber(col)) {
				//
				//	Modify text to have information from index
				//	before and and after column
				//
				//	:TODO: Need to clean this string (e.g. collapse tabs)
				text = self.textLines

				//	:TODO: Remove original line @ index
			}
		} else {
			index = self.textLines.length;
		}

		text = text
			.replace(/\b/g, '')
			.split(/\r\n|[\n\v\f\r\x85\u2028\u2029]/g);

		var wrapped;
		
		for(var i = 0; i < text.length; ++i) {
			wrapped = self.wordWrapSingleLine(text[i], 'expandTabs', self.dimens.width).wrapped;

			for(var j = 0; j < wrapped.length - 1; ++j) {
				self.textLines.splice(index++, 0, { text : wrapped[j] } );
			}
			self.textLines.splice(index++, 0, { text : wrapped[wrapped.length - 1], eol : true });
		}
	};

	this.getAbsolutePosition = function(row, col) {
		return { 
			row : self.position.row + row,
			col : self.position.col + col,
		};
	};

	this.moveClientCusorToCursorPos = function() {
		var absPos = self.getAbsolutePosition(self.cursorPos.row, self.cursorPos.col);
		self.client.term.rawWrite(ansi.goto(absPos.row, absPos.col));
	};


	this.keyPressCharacter = function(c) {
		var index = self.getTextLinesIndex();

		//
		//	:TODO: stuff that needs to happen
		//	* Break up into smaller methods
		//	* Even in overtype mode, word wrapping must apply if past bounds
		//	* A lot of this can be used for backspacing also
		//	* See how Sublime treats tabs in *non* overtype mode... just overwrite them?
		//
		//

		if(self.overtypeMode) {
			//	:TODO: special handing for insert over eol mark?
			self.replaceCharacterInText(c, index, self.cursorPos.col);
			self.cursorPos.col++;
			self.client.term.write(c);
		} else {
			self.insertCharactersInText(c, index, self.cursorPos.col);
		}

		self.emitEditPosition();
	};

	this.keyPressUp = function() {
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			self.client.term.rawWrite(ansi.up());

			if(!self.adjustCursorToNextTab('up')) {
				self.adjustCursorIfPastEndOfLine(false);
			}
		} else {
			self.scrollDocumentDown();
			self.adjustCursorIfPastEndOfLine(true);
		}

		self.emitEditPosition();
	};

	this.keyPressDown = function() {
		var lastVisibleRow = Math.min(
			self.dimens.height, 
			(self.textLines.length - self.topVisibleIndex)) - 1;

		if(self.cursorPos.row < lastVisibleRow) {
			self.cursorPos.row++;
			self.client.term.rawWrite(ansi.down());

			if(!self.adjustCursorToNextTab('down')) {
				self.adjustCursorIfPastEndOfLine(false);
			}
		} else {
			self.scrollDocumentUp();
			self.adjustCursorIfPastEndOfLine(true);
		}

		self.emitEditPosition();
	};

	this.keyPressLeft = function() {
		if(self.cursorPos.col > 0) {
			var prevCharIsTab = self.isTab();

			self.cursorPos.col--;
			self.client.term.rawWrite(ansi.left());

			if(prevCharIsTab) {
				self.adjustCursorToNextTab('left');
			}
		} else {
			self.cursorEndOfPreviousLine();
		}

		self.emitEditPosition();
	};

	this.keyPressRight = function() {
		var eolColumn = self.getTextEndOfLineColumn();
		if(self.cursorPos.col < eolColumn) {
			var prevCharIsTab = self.isTab();

			self.cursorPos.col++;
			self.client.term.rawWrite(ansi.right());

			if(prevCharIsTab) {
				self.adjustCursorToNextTab('right');
			}
		} else {
			self.cursorBeginOfNextLine();
		}

		self.emitEditPosition();
	};

	this.keyPressHome = function() {
		var firstNonWhitespace = self.getVisibleText().search(/\S/);
		if(-1 !== firstNonWhitespace) {
			self.cursorPos.col = firstNonWhitespace;
		} else {
			self.cursorPos.col = 0;
		}
		console.log('"' + self.getVisibleText() + '"')
		self.moveClientCusorToCursorPos();

		self.emitEditPosition();
	};

	this.keyPressEnd = function() {
		self.cursorPos.col = self.getTextEndOfLineColumn();
		self.moveClientCusorToCursorPos();
		self.emitEditPosition();
	};

	this.keyPressPageUp = function() {
		if(self.topVisibleIndex > 0) {
			self.topVisibleIndex = Math.max(0, self.topVisibleIndex - self.dimens.height);
			self.redraw();
			self.adjustCursorIfPastEndOfLine(true);
		} else {
			self.cursorPos.row = 0;
			self.moveClientCusorToCursorPos();	//	:TODO: ajust if eol, etc.
		}

		self.emitEditPosition();
	};

	this.keyPressPageDown = function() {
		var linesBelow = self.getRemainingLinesBelowRow();
		if(linesBelow > 0) {
			self.topVisibleIndex += Math.min(linesBelow, self.dimens.height);
			self.redraw();
			self.adjustCursorIfPastEndOfLine(true);
		}

		self.emitEditPosition();
	};

	this.keyPressLineFeed = function() {
		//
		//	Break up text from cursor position, redraw, and update cursor
		//	position to start of next line
		//
		var index			= self.getTextLinesIndex();
		var nextEolIndex	= self.getNextEndOfLineIndex(index);
		var text			= self.getContiguousText(index, nextEolIndex);
		var newLines		= self.wordWrapSingleLine(text.slice(self.cursorPos.col), 'tabsIntact').wrapped;
		
		newLines.unshift( { text : text.slice(0, self.cursorPos.col), eol : true } );
		for(var i = 1; i < newLines.length; ++i) {
			newLines[i] = { text : newLines[i] };
		}
		newLines[newLines.length - 1].eol = true;

		Array.prototype.splice.apply(
			self.textLines, 
			[ index, (nextEolIndex - index) + 1 ].concat(newLines));

		//	redraw from current row to end of visible area
		self.redrawRows(self.cursorPos.row, self.dimens.height);
		self.cursorBeginOfNextLine();

		self.emitEditPosition();
	};

	this.keyPressInsert = function() {
		self.toggleTextEditMode();
	};

	this.keyPressTab = function() {
		var index = self.getTextLinesIndex();
		self.insertCharactersInText(self.expandTab(self.cursorPos.col, '\t') + '\t', index, self.cursorPos.col);

		self.emitEditPosition();
	};

	this.keyPressBackspace = function() {
		if(self.cursorPos.col >= 1) {
			//
			//	Don't want to delete character at cursor, but rather the character
			//	to the left of the cursor!
			//
			self.cursorPos.col -= 1;

			var index = self.getTextLinesIndex();
			var count;

			if(self.isTab()) {
				var col = self.cursorPos.col;
				var prevTabStop = self.getPrevTabStop(self.cursorPos.col);
				while(col >= prevTabStop) {
					if(!self.isTab(index, col)) {
						break;
					}
					--col;
				}

				count = (self.cursorPos.col - col);
			} else {
				count = 1;
			}

			self.removeCharactersFromText(
				index,
				self.cursorPos.col,
				'backspace',
				count);
		} else {
			//
			//	Delete character at end of line previous.
			//	* This may be a eol marker
			//	* Word wrapping will need re-applied
			//
			//	:TODO: apply word wrapping such that text can be re-adjusted if it can now fit on prev
			self.keyPressLeft();	//	same as hitting left - jump to previous line
			//self.keyPressBackspace();
		}

		self.emitEditPosition();
	};

	this.keyPressDelete = function() {
		self.removeCharactersFromText(
			self.getTextLinesIndex(),
			self.cursorPos.col,
			'right',
			1);

		self.emitEditPosition();
	};

	//this.keyPressClearLine = function() {
	this.keyPressDeleteLine = function() {
		if(self.textLines.length > 0) {
			self.removeCharactersFromText(
				self.getTextLinesIndex(),
				0,
				'delete line');
		}

		self.emitEditPosition();
	};

	this.adjustCursorIfPastEndOfLine = function(forceUpdate) {
		var eolColumn = self.getTextEndOfLineColumn();
		if(self.cursorPos.col > eolColumn) {
			self.cursorPos.col = eolColumn;
			forceUpdate = true;
		}

		if(forceUpdate) {
			self.moveClientCusorToCursorPos();
		}
	};

	this.adjustCursorToNextTab = function(direction) {
		if(self.isTab()) {
			var move;
			switch(direction) {
				//
				//	Next tabstop to the right
				//
				case 'right' :
					move = self.getNextTabStop(self.cursorPos.col) - self.cursorPos.col;
					self.cursorPos.col += move;
					self.client.term.rawWrite(ansi.right(move));
					break;

				//
				//	Next tabstop to the left
				//
				case 'left' :
					move = self.cursorPos.col - self.getPrevTabStop(self.cursorPos.col);
					self.cursorPos.col -= move;
					self.client.term.rawWrite(ansi.left(move));
					break;

				case 'up' : 
				case 'down' :
					//	
					//	Jump to the tabstop nearest the cursor
					//
					var newCol = self.tabStops.reduce(function r(prev, curr) {
						return (Math.abs(curr - self.cursorPos.col) < Math.abs(prev - self.cursorPos.col) ? curr : prev);
					});

					if(newCol > self.cursorPos.col) {
						move = newCol - self.cursorPos.col;
						self.cursorPos.col += move;
						self.client.term.rawWrite(ansi.right(move));
					} else if(newCol < self.cursorPos.col) {
						move = self.cursorPos.col - newCol;
						self.cursorPos.col -= move;
						self.client.term.rawWrite(ansi.left(move));
					}
					break;
			}

			return true;
		}
		return false;	//	did not fall on a tab
	};

	this.cursorStartOfDocument = function() {
		self.topVisibleIndex	= 0;
		self.cursorPos			= { row : 0, col : 0 };

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.cursorEndOfDocument = function() {
		self.topVisibleIndex	= Math.max(self.textLines.length - self.dimens.height, 0);
		self.cursorPos.row		= (self.textLines.length - self.topVisibleIndex) - 1;
		self.cursorPos.col		= self.getTextEndOfLineColumn();

		self.redraw();
		self.moveClientCusorToCursorPos();
	};

	this.cursorBeginOfNextLine = function() {
		//	e.g. when scrolling right past eol
		var linesBelow = self.getRemainingLinesBelowRow();
	
		if(linesBelow > 0) {
			var lastVisibleRow	= Math.min(self.dimens.height, self.textLines.length) - 1;
			if(self.cursorPos.row < lastVisibleRow) {
				self.cursorPos.row++;
			} else {
				self.scrollDocumentUp();
			}
			self.keyPressHome();	//	same as pressing 'home'
		}
	};

	this.cursorEndOfPreviousLine = function() {
		//	e.g. when scrolling left past start of line
		var moveToEnd;
		if(self.cursorPos.row > 0) {
			self.cursorPos.row--;
			moveToEnd = true;
		} else if(self.topVisibleIndex > 0) {
			self.scrollDocumentDown();
			moveToEnd = true;
		}

		if(moveToEnd) {
			self.keyPressEnd();	//	same as pressing 'end'
		}
	};

	/*
	this.cusorEndOfNextLine = function() {
		var linesBelow = self.getRemainingLinesBelowRow();

		if(linesBelow > 0) {
			var lastVisibleRow = Math.min(self.dimens.height, self.textLines.length) - 1;
			if(self.cursorPos.row < lastVisibleRow) {
				self.cursorPos.row++;
			} else {
				self.scrollDocumentUp();
			}
			self.keyPressEnd();	//	same as pressing 'end'
		}
	};
	*/

	this.scrollDocumentUp = function() {
		//
		//	Note: We scroll *up* when the cursor goes *down* beyond
		//	the visible area!
		//
		var linesBelow = self.getRemainingLinesBelowRow();
		if(linesBelow > 0) {
			self.topVisibleIndex++;
			self.redraw();
		}
	};

	this.scrollDocumentDown = function() {
		//
		//	Note: We scroll *down* when the cursor goes *up* beyond
		//	the visible area!
		//
		if(self.topVisibleIndex > 0) {
			self.topVisibleIndex--;
			self.redraw();
		}
	};

	this.emitEditPosition = function() {
		self.emit('edit position', 	self.getEditPosition());
	};

	this.toggleTextEditMode = function() {
		self.overtypeMode = !self.overtypeMode;
		self.emit('text edit mode', self.getTextEditMode());
	};
}

require('util').inherits(MultiLineEditTextView, View);

MultiLineEditTextView.prototype.setWidth = function(width) {
	MultiLineEditTextView.super_.prototype.setWidth.call(this, width);

	this.calculateTabStops();
};

MultiLineEditTextView.prototype.redraw = function() {
	MultiLineEditTextView.super_.prototype.redraw.call(this);

	this.redrawVisibleArea();
};

MultiLineEditTextView.prototype.setFocus = function(focused) {
	this.client.term.rawWrite(this.getSGRFor('text'));
	this.moveClientCusorToCursorPos();

	MultiLineEditTextView.super_.prototype.setFocus.call(this, focused);
};

MultiLineEditTextView.prototype.setText = function(text) {
	//this.textLines = [ { text : '' } ];
	//this.insertRawText('');
	//text = "Tab:\r\n\tA\tB\tC\tD\tE\tF\tG\r\n reeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeally long word!!!";
	text = require('fs').readFileSync('/home/nuskooler/Downloads/test_text.txt', { encoding : 'utf-8'});

	this.insertRawText(text);//, 0, 0);
	this.cursorEndOfDocument();
	console.log(this.textLines)


};

MultiLineEditTextView.prototype.getData = function() {
	return this.getOutputText(0, this.textLines.length, true);
};

MultiLineEditTextView.prototype.setPropertyValue = function(propName, value) {
/*	switch(propName) {
		case 'text' : this.setText(value); break;
	}
*/
	MultiLineEditTextView.super_.prototype.setPropertyValue.call(this, propName, value);
};

var HANDLED_SPECIAL_KEYS = [
	'up', 'down', 'left', 'right', 
	'home', 'end',
	'page up', 'page down',
	'line feed',
	'insert',
	'tab',
	'backspace', 'del',
	'delete line',
];

MultiLineEditTextView.prototype.onKeyPress = function(ch, key) {
	var self = this;
	var handled;

	if(key) {		
		HANDLED_SPECIAL_KEYS.forEach(function aKey(specialKey) {
			if(self.isKeyMapped(specialKey, key.name)) {
				self[_.camelCase('keyPress ' + specialKey)]();
				handled = true;
			}
		});
	}

	if(ch && strUtil.isPrintable(ch)) {
		this.keyPressCharacter(ch);
	}

	if(!handled) {
		MultiLineEditTextView.super_.prototype.onKeyPress.call(this, ch, key);
	}
};

MultiLineEditTextView.prototype.getTextEditMode = function() {
	return this.overtypeMode ? 'overtype' : 'insert';
};

MultiLineEditTextView.prototype.getEditPosition = function() {
	return { row : this.getTextLinesIndex(this.cursorPos.row), col : this.cursorPos.col }
};

