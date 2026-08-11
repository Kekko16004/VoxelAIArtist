import sys
import pydantic
_orig = pydantic.ValidationError.__init__
def _patched(self, *args, **kwargs):
    print("PATCH WORKED!")
    _orig(self, *args, **kwargs)
pydantic.ValidationError.__init__ = _patched

class T(pydantic.BaseModel):
    a: str = ''
try:
    T(a=None)
except Exception:
    pass
