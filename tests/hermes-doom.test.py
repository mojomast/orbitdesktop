"""Explicit synthetic provider contracts plus real native engine integration."""
import sys, unittest, time, threading, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'extensions/hermes-doom'))
from jev import Controller, validate, payload_for
A={'forward':['MOVE_FORWARD'],'attack':['ATTACK']}
def result(confidence=.9):return {'answers':{'action':{'type':'choice','choice':'attack','confidence':confidence,'probabilities':{'forward':.1,'attack':.9}}},'usage':{'input_tokens':100,'output_tokens':5}}
class Contracts(unittest.TestCase):
    def test_offline(self):
        c=Controller(lambda *_:self.fail('external request'));self.assertEqual(c.choose({},A,'forward'),'forward')
    def test_consent(self):
        c=Controller()
        for key,consent,budget in [('abcdefgh',False,2),('',True,2),('abcdefgh',True,101),('abcdefgh',True,True)]:
            with self.assertRaises(ValueError):c.enable(key,consent,budget)
    def test_valid_and_budget(self):
        c=Controller(lambda *_:result());c.enable('fixture-key',True,1)
        self.assertEqual(c.choose({},A,'forward'),'attack');self.assertEqual(c.choose({},A,'forward'),'forward');self.assertEqual(c.snapshot()['accepted'],1);self.assertFalse(c.key)
    def test_low_confidence(self):
        c=Controller(lambda *_:result(.2));c.enable('fixture-key',True,3);self.assertEqual(c.choose({},A,'forward'),'forward');self.assertEqual(c.snapshot()['fallbacks'],1)
    def test_rate_limit(self):
        c=Controller(lambda *_:result());c.enable('fixture-key',True,3);c.choose({},A,'forward');c.choose({},A,'forward');self.assertEqual(c.snapshot()['calls'],1)
    def test_expiry(self):
        c=Controller(lambda *_:self.fail('expired request'));c.enable('fixture-key',True,3);c.deadline=0;self.assertEqual(c.choose({},A,'forward'),'forward');self.assertFalse(c.key)
    def test_invalid_stops(self):
        c=Controller(lambda *_:{});c.enable('fixture-key',True,3);self.assertEqual(c.choose({},A,'forward'),'forward');self.assertFalse(c.key);self.assertEqual(c.snapshot()['errors'],1)
    def test_nonfinite(self):
        for x in [float('nan'),float('inf'),True,-1,2]:
            with self.assertRaises(ValueError):validate(result(x),A)
    def test_unknown_action(self):
        r=result();r['answers']['action']['choice']='shell'
        with self.assertRaises(ValueError):validate(r,A)
    def test_stop_inflight(self):
        start=threading.Event();finish=threading.Event();answers=[]
        def transport(*_):start.set();finish.wait(2);return result()
        c=Controller(transport);c.enable('fixture-key',True,2)
        t=threading.Thread(target=lambda:answers.append(c.choose({},A,'forward')));t.start();start.wait(2);c.disable();finish.set();t.join();self.assertEqual(answers,['forward']);self.assertEqual(c.snapshot()['accepted'],0)
    def test_payload(self):
        p=payload_for({'health':10},A);self.assertEqual(set(p),{'model','state','questions'});self.assertNotIn('key',str(p))
    def test_native(self):
        import engine as e
        from main import observation
        e.DOOM_SHAREWARE_WAD=Path('/home/mojo/.hermes/skills/gaming/doom-player/wads/doom1.wad')
        controls=e.DoomState().controls;controls['seed']=42
        game=e.start_game(controls,'E1M1')
        try:
            game.make_action([0]*len(game.get_available_buttons()),35)
            frame=game.get_state();obs=observation(game,frame,0,'E1M1');self.assertEqual(obs['screen_width'],320);self.assertGreater(len(e.frame_from_vizdoom(frame.screen_buffer)),1000)
            buttons=[str(b).split('.')[-1] for b in game.get_available_buttons()]
            actions={k:v for k,v in e.LEARNED_ACTIONS.items() if set(v)<=set(buttons)}
            def native_fixture(*_):return {'answers':{'action':{'type':'choice','choice':'forward','confidence':.9,'probabilities':{a:float(a=='forward') for a in actions}}}}
            c=Controller(native_fixture);c.enable('fixture-key',True,1)
            before=e.get_player_position(game)
            name=c.choose(obs,actions,'turn_left');self.assertEqual(name,'forward')
            _,tics=e.execute_option(game,e.apply_action_names(buttons,actions[name]),name,3,True)
            self.assertGreater(tics,0);self.assertNotEqual(before,e.get_player_position(game))
        finally:game.close()
if __name__=='__main__':unittest.main()
