import os
import sys
import yaml
import fire
import json

from LLM import factory_llm
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
        config_path = os.path.join(custom_config_path, config_filename)
    if not os.path.exists(config_path):
        save_config(DEFAULT_CONFIG)  # Creates the config file with default config if it does not exist


def get_config():
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
    else:
        config = DEFAULT_CONFIG
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
    print(json.dumps({"status": "success", "message": "Configuration saved!"}))


def validate_config(config):
    for key, value in DEFAULT_CONFIG.items():
        if key not in config:
            config[key] = value
    if config.get("model_type") == "openai":
        api_key = config.get("api_key")
        if not api_key:
            print(json.dumps({"status": "error", "message": "Please configure your API key. Use talk-codebase configure"}))
            sys.exit(0)
    elif config.get("model_type") == "local":
        model_path = config.get("model_path")
        if not model_path:
            print(json.dumps({"status": "error", "message": "Please configure your model path. Use talk-codebase configure"}))
            sys.exit(0)
    save_config(config)
    return config


def loop(llm):
    while True:
        query = input("👉 ").lower().strip()
        if not query:
            print("🤖 Please enter a query")
            continue
        if query in ('exit', 'quit'):
            break
        llm.send_query(query)


def chat(root_dir, query):
    config = validate_config(get_config())
    llm = factory_llm(root_dir, config)
    response = llm.send_query(query)
    loop(llm)


class TalkCodebaseCLI:
    def __init__(self):
        pass

    def configure(self, model_type, api_key=None, model_name=None, model_path=None):
        configure(model_type, api_key, model_name, model_path)

    def set_config(self, custom_config_path=None):
        set_config(custom_config_path)

    def chat(self, root_dir, query, config_path=None):
        if config_path:
            self.set_config(config_path)
        chat(root_dir, query)


if __name__ == "__main__":
    try:
        fire.Fire(TalkCodebaseCLI)
    except KeyboardInterrupt:
        print(json.dumps({"status": "exit", "message": "Bye!"}))
    except Exception as e:
        if str(e) == "<empty message>":
            print(json.dumps({"status": "error", "message": "Please configure your API key. Use talk-codebase configure"}))
        else:
            raise e
