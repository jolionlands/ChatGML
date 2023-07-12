class CustomEditor {
    constructor(parent, containerId, mode = "ace/mode/text", isReadOnly = false, wrapColumnWidth = 80) {
        this.container = document.createElement('div');
        this.container.id = containerId;
        parent.appendChild(this.container);
        this.editor = GMEdit.aceTools.createEditor(this.container);
        this.editor.session.setMode(mode);
        this.editor = ace.edit(this.container);
        this.isReadOnly = isReadOnly;

        this.editor.setReadOnly(isReadOnly);

        // Set editor to use soft wrap (lines will wrap around visually in the editor, but not in the actual file)
        this.editor.setOptions({
			wrap: true,
			indentedSoftWrap: false,
			printMarginColumn: wrapColumnWidth
		});
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
}