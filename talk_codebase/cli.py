import os
import sys
import yaml
import fire
import json

from LLM import factory_llm
from consts import DEFAULT_CONFIG

config_path = os.path.join(os.path.expanduser("~"), ".talk_codebase_config.yaml")

def set_config(custom_config_path):
    global config_path
    print("config set")
    config_filename = "talk_codebase_config.yaml"
    config_path = os.path.join(custom_config_path, config_filename)
    print(config_path)
    # Check if config file exists, if not, create an empty one
    if not os.path.exists(config_path):
        save_config({})

        
def get_config():
    print("get config")
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
    else:
        config = {}
    print(config)
    return config


def save_config(config):
    print("saving config")
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
    print("chatting now")
    config = validate_config(get_config())
    llm = factory_llm(root_dir, config)
    response = llm.send_query(query)
    print("done chatting for  now")
    print(json.dumps(response))
    loop(llm)

class TalkCodebaseCLI:
    def __init__(self):
        pass

    def configure(self, model_type, api_key=None, model_name=None, model_path=None):
        configure(model_type, api_key, model_name, model_path)

    def set_config(self, custom_config_path):
        set_config(custom_config_path)

    def chat(self, root_dir, query):
        chat(root_dir, query)
        
    def set_config_and_chat(self, custom_config_path, root_dir, query):
        print("running")
        self.set_config(custom_config_path)
        self.chat(root_dir, query)

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