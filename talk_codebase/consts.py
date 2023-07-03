from langchain.document_loaders import CSVLoader, UnstructuredWordDocumentLoader, UnstructuredEPubLoader, \
    PDFMinerLoader, UnstructuredMarkdownLoader, TextLoader

EXCLUDE_DIRS = ['__pycache__', '.venv', '.git', '.idea', 'venv', 'env', 'node_modules', 'dist', 'build', '.vscode',
                '.github', '.gitlab', 'vector_store', 'models', 'data', 'logs', 'output']
ALLOW_FILES = ['.js', '.mjs', '.ts', '.tsx', '.css', '.scss', '.less', '.html', '.htm', '.json', '.py',
               '.java', '.c', '.cpp', '.cs', '.go', '.php', '.rb', '.rs', '.swift', '.kt', '.scala', '.m', '.h',
               '.sh', '.pl', '.pm', '.lua', '.sql','.gml']
EXCLUDE_FILES = ['requirements.txt', 'package.json', 'package-lock.json', 'yarn.lock', '.yy', '.yyp', '.yyz', '__init__.py', '__main__.py', '.gitignore']
MODEL_TYPES = {
    "OPENAI": "openai",
    "LOCAL": "local",
}
DEFAULT_CONFIG = {
    "api_key": None,
    "max_tokens": "16000",
    "chunk_size": "2056",
    "chunk_overlap": "256",
    "k": "2",
    "model_name": "gpt-3.5-turbo-16k-0613",
    "model_path": "models/ggml-gpt4all-j-v1.3-groovy.bin",
    "model_type": MODEL_TYPES["OPENAI"],
    "repo_path": None,
    "venv_path": None,
    "temperature": "0.7",
}

LOADER_MAPPING = {
    ".csv": {
        "loader": CSVLoader,
        "args": {}
    },
    ".doc": {
        "loader": UnstructuredWordDocumentLoader,
        "args": {}
    },
    ".docx": {
        "loader": UnstructuredWordDocumentLoader,
        "args": {}
    },
    ".epub": {
        "loader": UnstructuredEPubLoader,
        "args": {}
    },
    ".md": {
        "loader": UnstructuredMarkdownLoader,
        "args": {}
    },
    ".pdf": {
        "loader": PDFMinerLoader,
        "args": {}
    }
}

for ext in ALLOW_FILES:
    if ext not in LOADER_MAPPING:
        LOADER_MAPPING[ext] = {
            "loader": TextLoader,
            "args": {
                "encoding": "utf8"
            }
        }
