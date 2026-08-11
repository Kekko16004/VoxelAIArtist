import pydantic
class T(pydantic.BaseModel):
    a: str = ''
try:
    T(a=None)
except Exception as e:
    print(repr(e))
