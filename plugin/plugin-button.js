class PluginButton {
    constructor(container, text, task) {
        this.container = container;
        this.text = text;
        this.task = task;
        this.buttonElement = this.createButtonElement();
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

    isDisabled() {
        // Check if the button is disabled
        return this.buttonElement.getAttribute('disabled');
    }

    enable() {
        // Enable the button
        this.buttonElement.removeAttribute('disabled');
    }

    handleClick() {
        // Execute the task and handle any errors
        this.task().catch((error) => {
            // Handle any errors from the task
            console.error(`Error executing task: ${error}`);
        });
    }

    remove() {
        this.container.removeChild(this.buttonElement);
    }
}

class ToggleButton extends PluginButton {
    constructor(container, launchText, killText, launchTask, killTask, loadingText = 'Processing...') {
        super(container, launchText, launchTask);  // call the super class constructor and pass in the parameters
        this.loadingText = loadingText;
        this.launchText = launchText;
        this.killText = killText;
        this.launchTask = launchTask;
        this.killTask = killTask;
        this.processRunning = false;
    }

    launch() {
        this.processRunning = true;
        this.text = this.killText;
        this.task = this.killTask;
        this.buttonElement.textContent = this.text;
    }

    kill() {
        this.processRunning = false;
        this.text = this.launchText;
        this.task = this.launchTask;
        this.buttonElement.textContent = this.text;
    }

    switchState() {
        // Switch the state of the button from 'launch' to 'kill' or vice versa
        if (this.processRunning) {
            this.kill();
        } else {
            this.launch();
        }
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
            
            // Regardless of error, revert the text and switch state
            this.stopLoading();
            this.switchState();
        });
    }

    stopLoading() {
        // Restore the original button text when the task is done
        this.buttonElement.textContent = this.text;
        this.enable();
    }
}


class PluginButtonLoadable extends PluginButton {
    constructor(container, text, task, loadingText = 'Loading...') {
        super(container, text, task);  // call the super class constructor and pass in the parameters
        this.loadingText = loadingText;
    }

    stopLoading() {
        // Restore the original button text when the task is done
        this.buttonElement.textContent = this.text;
        this.enable();
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