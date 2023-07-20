class CustomEditor {
    constructor(parent, isReadOnly = false, mode = "ace/mode/text", wrapColumnWidth = 80, theme) {
        this.container = document.createElement('div');
        parent.appendChild(this.container);
        this.editor = GMEdit.aceTools.createEditor(this.container);
        this.editor.session.setMode(mode);

        if (theme) {
            this.editor.setTheme(theme);
        }

        // Set editor to use soft wrap (lines will wrap around visually in the editor, but not in the actual file)
        this.editor.setOptions({
            wrap: true,
            indentedSoftWrap: false,
            printMarginColumn: wrapColumnWidth
        });

        // Apply read-only settings if isReadOnly is true
        if (isReadOnly) {
            this.editor.setReadOnly(true);
            this.editor.setHighlightActiveLine(false);
            this.editor.setOption('highlightGutterLine', false);
            this.editor.renderer.$cursorLayer.element.style.opacity = 0;
            this.editor.textInput.getElement().tabIndex = -1;
            this.editor.blur();
        }
    }

    // Property for the editor content
    get content() {
        return this.editor.getValue();
    }

    // Method to set editor content
    setContent(value) {
        this.editor.setValue(value);
        this.editor.selection.clearSelection();
    }

    // Method to append content to the existing editor content
    appendContent(value) {
        const session = this.editor.session;
        const count = session.getLength();  // get number of lines
        session.insert({
            row: count, 
            column: session.getLine(count-1).length
        }, '\n' + value);  // append at end of the file
    }

}