const path = require('path');
const EventEmitter = require('events');

class FileElement extends EventEmitter {
    constructor(path, content) {
        super();
        this.path = path;
        this.content = content;
        this.element = null;
        this.contentVisible = false;
        this.name = path.basename(path);
    }

    buildElement() {
        // Create the main element
        this.element = document.createElement('div');
        this.element.className = 'file-element collapsible';

        // Add the file name as text
        this.element.innerText = this.name;

        // Create the content element and add the file content
        const contentElement = document.createElement('div');
        contentElement.className = 'content';
        contentElement.innerText = this.content;

        // Add the content element to the main element
        this.element.appendChild(contentElement);

        // Create a button to deselect the file
        const deselectButton = document.createElement('button');
        deselectButton.innerText = "✕";
        deselectButton.addEventListener('click', () => {
            this.element.remove();
            this.emit('deselected', this.path);  // Emit an event when a file is deselected
        });

        // Add the deselect button to the main element
        this.element.appendChild(deselectButton);

        // Add a click listener to the main element to control the visibility of the content
        this.element.addEventListener('click', () => {
            this.toggleContentVisibility();
        });

        return this.element;
    }

    toggleContentVisibility() {
        this.contentVisible = !this.contentVisible;

        // Get the content element
        const contentElement = this.element.querySelector('.content');

        // Toggle the display property
        contentElement.style.display = this.contentVisible ? 'block' : 'none';
    }
}
