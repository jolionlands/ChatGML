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

class PythonProcessButton extends PluginButtonLoadable {
    constructor(container, launchText, killText, launchTask, loadingText = 'Processing...', stdoutCallback, stderrCallback) {
        super(container, launchText, launchTask, loadingText);
        this.state = 'launch'; // The button starts in the "Launch" state
        this.killText = killText;
        this.stdoutCallback = stdoutCallback;
        this.stderrCallback = stderrCallback;
        this.pythonProcess = null;
    }

    launchPythonProcess() {
        this.task().then((pythonProcess) => {
            this.pythonProcess = pythonProcess;

            if (this.pythonProcess) {
                console.log('Python process launched successfully.');

                // Switch to the "Kill" state
                this.setKillState();

                this.pythonProcess.on('error', (error) => {
                    console.error('Failed to start subprocess.', error);
                    this.killPythonProcess();
                });

                this.pythonProcess.on('close', (code) => {
                    console.log('Python script exited with code:', code);
                    this.killPythonProcess();
                });

                // Python process disconnect event
                this.pythonProcess.on('disconnect', () => {
                    console.log('Python process disconnected');
                    this.killPythonProcess();
                });

                // Python process exit event
                this.pythonProcess.on('exit', (code, signal) => {
                    console.log(`Python process exited with code ${code} and signal ${signal}`);
                    this.killPythonProcess();
                });

                // Listen for data events on stdout
                this.pythonProcess.stdout.on('data', (data) => {
                    let dataStr = data.toString('utf8').trim(); // Convert buffer to string
                    this.stdoutCallback(dataStr); // Call the provided callback
                });

                // Listen for data events on stderr
                this.pythonProcess.stderr.on('data', (data) => {
                    let dataStr = data.toString('utf8').trim(); // Convert buffer to string
                    this.stderrCallback(dataStr); // Call the provided callback
                });
            } else {
                console.error('Failed to start the Python process.');
                this.setLaunchState(); // Switch back to the "Launch" state
            }
        }).catch((error) => {
            console.error('Failed to start the Python process:', error);
            this.setLaunchState(); // Switch back to the "Launch" state
        });
    }

    killPythonProcess() {
        if (this.pythonProcess) {
            this.pythonProcess.kill();
            this.pythonProcess = null;
            console.log("Python process killed.");
        } else {
            console.warn("Python process is not running.");
        }
        this.setLaunchState(); // Switch back to the "Launch" state
    }

    setLaunchState() {
        this.state = 'launch';
        this.text = this.launchText;
        this.buttonElement.textContent = this.text;
        this.enable();
    }

    setKillState() {
        this.state = 'kill';
        this.text = this.killText;
        this.buttonElement.textContent = this.text;
        this.enable();
    }

    handleClick() {
        if (this.isDisabled()) return;
        if (this.state === 'launch') {
            this.disable();
            this.buttonElement.textContent = this.loadingText;

            // Execute the task and handle any errors
            this.launchPythonProcess().catch((error) => {
                // Handle any errors from the task
                console.error(`Error launching Python process: ${error}`);
                
                // Revert the text and state
                this.setLaunchState();
            });
        } else if (this.state === 'kill') {
            this.disable();
            this.buttonElement.textContent = this.loadingText;

            try {
                this.killPythonProcess();
            } catch (error) {
                console.error(`Error killing Python process: ${error}`);
                this.setKillState(); // Switch back to the "Kill" state
            }
        } else {
            console.error('Invalid button state:', this.state);
        }
    }

}