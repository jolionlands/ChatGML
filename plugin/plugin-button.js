class PluginButton {
    constructor(container, text, task, loadingText = 'Loading...') {
        this.container = container;
        this.text = text;
        this.task = task;
        this.loadingText = loadingText;
        this.buttonElement = this.createButtonElement();
        console.log(this.buttonElement); // Log the button after the spinner is added
    }

    createButtonElement() {
        // Create the button
        let button = document.createElement("button");
        button.textContent = this.text;
        button.classList.add("run-button");

        // Add the click event listener
        button.addEventListener("click", () => this.handleClick());

        // Add the button to the container
        this.container.appendChild(button);

        return button;
    }

    disable() {
        // Disable the button
        this.buttonElement.setAttribute('disabled', 'disabled');
    }

    enable() {
        // Enable the button
        this.buttonElement.removeAttribute('disabled');
    }

    remove() {
        this.container.removeChild(this.buttonElement);
    }

    stopLoading() {
        // Restore the original button text when the task is done
        this.buttonElement.textContent = this.text;
        this.enable();
    }

    isDisabled() {
        // Check if the button is disabled
        return this.buttonElement.getAttribute('disabled');
    }

    handleClick() {
        // If the button is disabled, do not execute the task
        if (this.isDisabled()) return;

        // Disable the button
        this.disable();

        // Show the loading text when the button is clicked
        this.buttonElement.textContent = this.loadingText;

        // Execute the task and handle any errors
        this.task().catch((error) => {
            // Handle any errors from the task
            console.error(`Error executing task: ${error}`);
            
            // Regardless of error, revert the text
            this.stopLoading();
        });
    }
}