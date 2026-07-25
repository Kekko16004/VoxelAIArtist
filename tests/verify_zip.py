"""Verifica che lo ZIP prodotto da 29-zip.js sia leggibile da un'implementazione
indipendente (la libreria standard di Python). Consumato da tests/run_all.sh."""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, ".test_out.zip")

if not os.path.exists(path):
    print("ZIP di prova non trovato: esegui prima tests/test_zip.mjs")
    sys.exit(1)

z = zipfile.ZipFile(path)
bad = z.testzip()
if bad is not None:
    print("CRC non valido per: %s" % bad)
    sys.exit(1)
names = z.namelist()
# Il contenuto deve tornare identico a quello scritto, binari e UTF-8 inclusi.
assert z.read("pack/Vaso_Fiori_1/model.json").decode() == '{"voxels":[]}'
assert z.read("pack/Vaso_Fiori_1/model.vox") == bytes([0x56, 0x4F, 0x58, 0x20, 1, 2, 3])
assert "accenti e UTF-8" in z.read("pack/accenti_àèìòù.txt").decode("utf-8")
print("validazione incrociata con Python zipfile: OK (%d file, testo+binario+UTF-8)" % len(names))
z.close()
os.remove(path)
