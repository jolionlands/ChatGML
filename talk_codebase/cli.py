# cli.py

import os
import sys
import yaml
import fire
from llm import factory_llm
from consts import DEFAULT_CONFIG

home_dir = os.path.expanduser("~")
config_dir = os.path.join(home_dir, "talk_codebase")
config_filename = "talk_codebase_config.yaml"
config_path = os.path.join(config_dir, config_filename)

# Create the config directory if it does not exist
if not os.path.exists(config_dir):
    os.makedirs(config_dir)

def set_config(custom_config_path=None):
    global config_path
    if custom_config_path is not None:
        sys.stderr.write(f"Config path already set: {custom_config_path}")
        config_path = os.path.join(custom_config_path, config_filename)
    if not os.path.exists(config_path):
        sys.stderr.write("Writing config file...")
        get_config()  # Creates the config file with default config if it does not exist

def get_config():
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
    else:
        config = DEFAULT_CONFIG
        save_config(config)  # Save the default config to create the YAML file
    return config

def save_config(config):
    with open(config_path, "w") as f:
        yaml.dump(config, f)


def configure(model_type, api_key=None, model_name=None, model_path=None):
    config = get_config()
    config["model_type"] = model_type
    if model_type == "openai":
        config["api_key"] = api_key
        config["model_name"] = model_name if model_name else DEFAULT_CONFIG["model_name"]
    elif model_type == "local":
        config["model_path"] = model_path if model_path else DEFAULT_CONFIG["model_path"]
    save_config(config)
    sys.stderr.write("Configuration saved!")


def validate_config(config):
    for key, value in DEFAULT_CONFIG.items():
        if key not in config:
            config[key] = value
    if config.get("model_type") == "openai":
        api_key = config.get("api_key")
        if not api_key:
            sys.stderr.write("API key not configured")
            sys.exit(0)
    elif config.get("model_type") == "local":
        model_path = config.get("model_path")
        if not model_path:
            sys.stderr.write("Model path not configured")
            sys.exit(0)
    save_config(config)
    return config


def loop(llm):
    sys.stderr.write("Entered loop for queries...")
    query = ""
    while True:  # Keep this loop running indefinitely
        line = sys.stdin.readline().strip()  # Try to read a line
        if line == "RECREATE_VECTOR_STORE":
            sys.stderr.write("User requested vector store recreation...")
            # Exit the loop and trigger recreation in `chat(root_dir)`
            return "RECREATE_VECTOR_STORE"
        if not line:  # If the line is empty (no input)
            continue  # Just go back to the start of the loop
        if line.endswith("END"):
            query += line.replace("END", "").lower().strip()  # Remove end signal from line and add to query
            if query in ('exit', 'quit'):
                sys.stderr.write("User requested exit. Exiting query loop...")
                break
            sys.stderr.write("About to send query to the model...")
            llm.send_query(query)
            query = ""
        else:
            query += line.lower().strip() + " "  # Add space between lines

def chat(root_dir):
    config = validate_config(get_config())
    llm = factory_llm(root_dir, config)
    while True:
        result = loop(llm)
        if result == "RECREATE_VECTOR_STORE":
            sys.stderr.write("Recreating vector store...")
            llm.vector_store = llm._create_store(root_dir, force_recreate=True)
            sys.stderr.write("Vector store recreated. Restarting chat...")
        else:
            break


class TalkCodebaseCLI:
    def __init__(self):
        pass

    def configure(self, model_type, api_key=None, model_name=None, model_path=None):
        configure(model_type, api_key, model_name, model_path)

    def set_config(self, custom_config_path=None):
        sys.stderr.write("Setting config...")
        set_config(custom_config_path)

    def chat(self, root_dir):
        sys.stderr.write("Starting chat...")
        chat(root_dir)


if __name__ == "__main__":
    try:
        fire.Fire(TalkCodebaseCLI)
    except KeyboardInterrupt:
        sys.stderr.write("Bye!")
    except Exception as e:
        if str(e) == "<empty message>":
            sys.stderr.write("Please configure your API key. Use talk-codebase configure")
        else:
            sys.stderr.write(str(e))
