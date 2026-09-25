import sys,unittest,io,wave,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'extensions/mimo-bench'))
import voice
class Tests(unittest.TestCase):
    def test_tts(self):
        p=voice.payload(dict(model=voice.MODELS[0],text='Hello',consent=True));self.assertEqual(p['messages'][-1]['role'],'assistant');self.assertEqual(p['audio']['voice'],'Chloe')
    def test_guards(self):
        for changes in [dict(consent=False),dict(model='bad'),dict(text=''),dict(text='a'*1501),dict(endpoint='http://bad')]:
            with self.assertRaises(ValueError):voice.payload(dict(dict(model=voice.MODELS[0],text='Hi',consent=True),**changes))
    def test_design(self):
        with self.assertRaises(ValueError):voice.payload(dict(model=voice.MODELS[1],text='Hi',consent=True))
        p=voice.payload(dict(model=voice.MODELS[1],text='Hi',consent=True,style='Warm narrator'));self.assertNotIn('voice',p['audio'])
    def test_audio(self):
        b=io.BytesIO()
        with wave.open(b,'wb') as w:w.setparams((1,2,24000,0,'NONE',''));w.writeframes(b'\0'*4800)
        audio='data:audio/wav;base64,'+base64.b64encode(b.getvalue()).decode()
        d=dict(model=voice.MODELS[2],text='Hi',consent=True,audio=audio)
        with self.assertRaises(ValueError):voice.payload(d)
        self.assertEqual(voice.payload(dict(d,rights=True))['audio']['voice'],audio)
        self.assertEqual(voice.payload(dict(d,model=voice.MODELS[3]))['asr_options']['language'],'auto')
        for a in ['https://bad','data:audio/wav;base64,bad','data:audio/mpeg;base64,YmFk']:
            with self.assertRaises(ValueError):voice.payload(dict(d,audio=a))
if __name__=='__main__':unittest.main()
