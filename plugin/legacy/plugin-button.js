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

    startLoading() {
        // Disable the button to prevent multiple clicks
        this.disable();

        // Show the loading text when the button is clicked
        this.buttonElement.textContent = this.loadingText;
    }

    handleClick() {
        // If the button is disabled, do not execute the task
        if (this.isDisabled()) return;

        // Call task function and capture the result
        const wasTaskStarted = this.task();
        if (wasTaskStarted) {
            // Start loading if task succeeds/criteria is met
            this.startLoading();
        }
    }
}

class PythonProcessButton extends PluginButtonLoadable {
    constructor(container, launchText, killText, launchTask, loadingText = 'Processing...', stdoutCallback, stderrCallback, processStartedMessage) {
        super(container=container, launchText, launchTask, loadingText);
        this.launchText = launchText;
        this.killText = killText;
        this.stdoutCallback = stdoutCallback;
        this.stderrCallback = stderrCallback;
        this.pythonProcess = null;
        this.processStartedMessage = processStartedMessage;
        this.setKilledState();
    }

    stopLoading() {
        this.setLaunchedState();
    }

    launchPythonProcess() {
        if (this.state === 'launching') return;

        this.state = 'launching';
        this.disable();
        this.buttonElement.textContent = this.loadingText;

        this.task().then((pythonProcess) => {
            this.pythonProcess = pythonProcess;

            if (this.pythonProcess) {
                console.log('Python process launched successfully.');

                // Listen for data events on stdout
                this.pythonProcess.stdout.on('data', (data) => {
                    let dataStr = data.toString('utf8').trim(); // Convert buffer to string
                    this.stdoutCallback(dataStr); // Call the provided callback
                
                    if (dataStr.includes(this.processStartedMessage)) {
                        this.setLaunchedState();
                    }
                });

                // Listen for data events on stderr
                this.pythonProcess.stderr.on('data', (data) => {
                    let dataStr = data.toString('utf8').trim(); // Convert buffer to string
                    this.stderrCallback(dataStr); // Call the provided callback
               
                    if (dataStr.includes(this.processStartedMessage)) {
                        this.setLaunchedState();
                    }
                });
                
                // If the process exits or disconnects, kill the process
                this.pythonProcess.on('exit', () => this.killPythonProcess());
                this.pythonProcess.on('disconnect', () => this.killPythonProcess());
            } else {
                console.error('Failed to start the Python process.');
                this.setKilledState();
            }
        }).catch((error) => {
            console.error('Failed to start the Python process:', error);
            this.state = 'killed';
            this.setKilledState();
        });
    }

    killPythonProcess() {
        console.log('killPythonProcess() called');
        if (this.pythonProcess) {
            this.state = 'killing';
            this.buttonElement.textContent = this.loadingText;
            this.pythonProcess.kill();
            this.pythonProcess = null;
            console.log("Python process killed.");
            this.setKilledState();
        } else {
            console.warn("Python process is not running.");
            this.setKilledState();
        }
    }

    _stateChanged() {
        // Emit an event to indicate that the state has changed
        this.buttonElement.dispatchEvent(new CustomEvent('stateChanged', { detail: this.state }));
    }

    setLaunchedState() {
        this.state = 'launched';
        this.text = this.killText;  // Text should show the option to "kill"
        this.buttonElement.textContent = this.text;
        this.enable();
        this._stateChanged();
    }

    setKilledState() {
        this.state = 'killed';
        this.text = this.launchText;  // Text should show the option to "launch"
        this.buttonElement.textContent = this.text;
        this.enable();
        this._stateChanged();
    }

    handleClick() {
        if (this.isDisabled()) return;
        if (this.state === 'killed') {
            this.launchPythonProcess();
        } else if (this.state === 'launched') {
            this.killPythonProcess();
        } else {
            console.error('Invalid button state:', this.state);
        }
    }
}