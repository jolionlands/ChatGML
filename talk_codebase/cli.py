import os
import sys
import yaml
import fire
import json

from talk_codebase.LLM import factory_llm
from talk_codebase.consts import DEFAULT_CONFIG

config_path = os.path.join(os.path.expanduser("~"), ".talk_codebase_config.yaml")


def get_config():
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
    else:
        config = {}
    return config


def save_config(config):
    home_dir = os.path.expanduser("~")
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


def chat(root_dir):
    config = validate_config(get_config())
    llm = factory_llm(root_dir, config)
    for line in sys.stdin:
        query = line.lower().strip()
        if query in ('exit', 'quit'):
            break
        response = llm.send_query(query)
        print(json.dumps(response))


def main():
    try:
        fire.Fire({
            "chat": chat,
            "configure": configure
        })
    except KeyboardInterrupt:
        print(json.dumps({"status": "exit", "message": "Bye!"}))
    except Exception as e:
        if str(e) == "<empty message>":
            print(json.dumps({"status": "error", "message": "Please configure your API key. Use talk-codebase configure"}))
        else:
            raise e


if __name__ == "__main__":
    main()