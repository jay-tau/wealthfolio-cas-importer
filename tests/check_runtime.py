# Checks the add-on's Python runtime against the casparser it bundles. tests/runtime.test.mjs
# runs these under Pyodide; each returns a list of problems, empty when all is well.
import ast
import importlib.util
import inspect
import pathlib

import casparser
import casparser_isin

PACKAGE = pathlib.Path(casparser.__file__).parent
# casparser's command line. The add-on only calls read_cas_pdf, so the command line's
# dependencies (click, rich) aren't bundled.
CLI = "casparser/cli.py"


def _modules():
    for path in sorted(PACKAGE.rglob("*.py")):
        yield path.relative_to(PACKAGE.parent).as_posix(), ast.parse(path.read_text(), path.name)


def _type_checking_nodes(tree):
    """Nodes inside `if TYPE_CHECKING:`, which never run."""
    nodes = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING":
            for child in node.body:
                nodes.update(id(inner) for inner in ast.walk(child))
    return nodes


def missing_imports():
    """Modules casparser imports, outside its command line, that the runtime can't find."""
    missing = []
    for name, tree in _modules():
        if name == CLI:
            continue
        skip = _type_checking_nodes(tree)
        for node in ast.walk(tree):
            if id(node) in skip:
                continue
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                modules = [node.module]
            else:
                continue
            for module in modules:
                try:
                    found = importlib.util.find_spec(module) is not None
                except ModuleNotFoundError:
                    found = False
                if not found:
                    missing.append(f"{name}:{node.lineno}: {module}")
    return missing


def _binds(function, call):
    """Whether the call's arguments fit the stub's signature."""
    if any(isinstance(arg, ast.Starred) for arg in call.args) or any(kw.arg is None for kw in call.keywords):
        return False
    try:
        inspect.signature(function).bind(*call.args, **{kw.arg: kw.value for kw in call.keywords})
        return True
    except TypeError:
        return False


def stub_gaps():
    """casparser_isin classes and methods casparser uses that the stub lacks or can't take.

    casparser opens the database as `with MFISINDb() as db:` and calls methods on `db`. Any
    other use is reported too, so a new pattern gets a look instead of passing unchecked.
    """
    gaps = []
    for name, tree in _modules():
        classes = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and any(a.name.split(".")[0] == "casparser_isin" for a in node.names):
                gaps.append(f"{name}:{node.lineno}: `import casparser_isin` isn't checked")
            elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "casparser_isin":
                for alias in node.names:
                    if node.module == "casparser_isin" and inspect.isclass(getattr(casparser_isin, alias.name, None)):
                        classes[alias.asname or alias.name] = getattr(casparser_isin, alias.name)
                    else:
                        gaps.append(f"{name}:{node.lineno}: the stub has no {node.module}.{alias.name}")
        checked = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.With, ast.AsyncWith)):
                continue
            for item in node.items:
                call, var = item.context_expr, item.optional_vars
                if not (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Name)
                    and call.func.id in classes
                    and isinstance(var, ast.Name)
                ):
                    continue
                cls = classes[call.func.id]
                checked.add(id(call.func))
                if not _binds(cls, call):
                    gaps.append(f"{name}:{call.lineno}: the stub's {cls.__name__}() can't take these arguments")
                attributes = set()
                for inner in ast.walk(node):
                    if not (
                        isinstance(inner, ast.Call)
                        and isinstance(inner.func, ast.Attribute)
                        and isinstance(inner.func.value, ast.Name)
                        and inner.func.value.id == var.id
                    ):
                        continue
                    attributes.add(id(inner.func.value))
                    method = getattr(cls(), inner.func.attr, None)
                    if method is None:
                        gaps.append(f"{name}:{inner.lineno}: the stub has no {cls.__name__}.{inner.func.attr}")
                    elif not _binds(method, inner):
                        gaps.append(f"{name}:{inner.lineno}: the stub's {cls.__name__}.{inner.func.attr} can't take these arguments")
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Name) and inner.id == var.id and inner is not var and id(inner) not in attributes:
                        gaps.append(f"{name}:{inner.lineno}: {var.id} from {cls.__name__}() is used other than by calling its methods")
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id in classes and id(node) not in checked:
                gaps.append(f"{name}:{node.lineno}: {node.id} is used other than as `with {node.id}() as db:`")
    return gaps


def unmet_requirements(bundled, unbundled):
    """Requirements of the bundled distributions that the bundle doesn't meet.

    `bundled` names the bundled distributions; requirements on names in `unbundled` are left
    out on purpose. Needs `packaging`, which the add-on doesn't bundle.
    """
    from importlib.metadata import distributions

    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name

    bundled = {canonicalize_name(name) for name in bundled}
    unbundled = {canonicalize_name(name) for name in unbundled}
    versions = {canonicalize_name(dist.name): dist.version for dist in distributions()}
    unmet = []
    for dist in distributions():
        if canonicalize_name(dist.name) not in bundled:
            continue
        for line in dist.requires or []:
            requirement = Requirement(line)
            if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                continue
            needed = canonicalize_name(requirement.name)
            if needed in unbundled:
                continue
            if needed not in bundled:
                unmet.append(f"{dist.name} {dist.version} needs {requirement}, which isn't bundled")
            elif not requirement.specifier.contains(versions[needed], prereleases=True):
                unmet.append(f"{dist.name} {dist.version} needs {requirement}, but {versions[needed]} is bundled")
    return unmet
