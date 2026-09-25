"""Private JSON-lines worker; models stay loaded until the parent retires us."""
import contextlib
import json
import os
import sys
import time
from pathlib import Path

BASE = Path('/home/mojo/.hermes-instances/fresh/workspace/supra2-service')
sys.path.insert(0, str(BASE))


def main():
    protocol = sys.stdout
    # Third-party loading messages must never corrupt the protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import inference as inf
        from transformers import AutoTokenizer, T5EncoderModel
        from diffusers import AutoencoderKL
        from torchvision.utils import save_image
        torch.set_num_threads(int(os.environ['OMP_NUM_THREADS']))
        torch.set_num_interop_threads(1)
        model = inf.SupraDiT().eval()
        state = torch.load(BASE / 'model_final_ema.pt', map_location='cpu', weights_only=False)
        cfg = state.get('config', {})
        if cfg.get('patch', inf.PATCH) != inf.PATCH:
            raise RuntimeError('Checkpoint patch mismatch')
        model.load_state_dict(state['ema'] if 'ema' in state else state.get('model', state), strict=True)
        del state
        ctx_len = int(cfg.get('ctx_len', inf.MAX_CTX_LEN))
        tokenizer = AutoTokenizer.from_pretrained(inf.T5_NAME, local_files_only=True)
        text_model = T5EncoderModel.from_pretrained(inf.T5_NAME, local_files_only=True).eval()
        vae = AutoencoderKL.from_pretrained(inf.VAE_NAME, local_files_only=True).eval()
        with torch.no_grad():
            if 'uncond_text' in cfg:
                uncond_ctx = cfg['uncond_text'].float().unsqueeze(0)
                uncond_mask = cfg['uncond_mask'].float().unsqueeze(0)
            else:
                u = tokenizer([''], padding='max_length', truncation=True, max_length=ctx_len, return_tensors='pt')
                uncond_ctx = text_model(**u).last_hidden_state.float()
                uncond_mask = u['attention_mask'].float()
        from prompt_cache import PromptCache
        prompt_cache = PromptCache()

        def encode(prompt):
            tok = tokenizer([prompt], padding='max_length', truncation=True, max_length=ctx_len, return_tensors='pt')
            return text_model(**tok).last_hidden_state.float(), tok['attention_mask'].float()

        for line in sys.stdin:
            try:
                d = json.loads(line)
                start = time.monotonic()
                with torch.no_grad():
                    torch.manual_seed(d['seed'])
                    encode_start = time.monotonic()
                    (ctx, mask), cache_hit = prompt_cache.get(d['prompt'], encode, enabled=d.get('prompt_cache', True))
                    encode_seconds = time.monotonic() - encode_start
                    use_cfg = d['cfg'] > 1
                    if use_cfg:
                        ctx_all = torch.cat([ctx, uncond_ctx], 0)
                        mask_all = torch.cat([mask, uncond_mask], 0)
                    z = torch.randn(1, inf.LATENT_CH, inf.LATENT_SIZE, inf.LATENT_SIZE)
                    dt = 1.0 / d['steps']
                    for i in range(d['steps']):
                        t = torch.full((1,), i * dt)
                        if use_cfg:
                            both = model(torch.cat([z, z], 0), torch.cat([t, t], 0), ctx_all, mask_all)
                            cond, uncond = both.float().chunk(2, 0)
                            v = uncond + d['cfg'] * (cond - uncond)
                        else:
                            v = model(z, t, ctx, mask).float()
                        z = z + dt * v
                    imgs = (vae.decode(z / inf.VAE_SCALE).sample.clamp(-1, 1) + 1) / 2
                    save_image(imgs, d['out'], nrow=1)
                result = {'ok': True, 'generation_seconds': round(time.monotonic()-start, 3),
                          'prompt_cache_hit': cache_hit, 'prompt_encode_seconds': round(encode_seconds, 6),
                          'prompt_cache_entries': len(prompt_cache.entries), 'prompt_cache_bytes': prompt_cache.bytes}
            except Exception:
                # Do not echo prompts, paths or exception contents into responses.
                result = {'ok': False}
            protocol.write(json.dumps(result) + '\n')
            protocol.flush()


if __name__ == '__main__':
    main()
