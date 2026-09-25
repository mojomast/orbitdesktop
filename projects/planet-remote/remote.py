import tkinter as tk
from tkinter import ttk
from pathlib import Path
import json, time
BASE=Path.home()/'.local/share/planet-remote'
BASE.mkdir(parents=True,exist_ok=True)
root=tk.Tk(); root.title('Planet Remote → Orbit'); root.geometry('460x420'); root.configure(bg='#10182b')
def label(s):
    tk.Label(root,text=s,bg='#10182b',fg='#eef5ff',font=('Sans',13)).pack(pady=10)
label('✦  PLANET REMOTE  ✦')
label('Control the planet in your Orbit workspace')
theme=ttk.Combobox(root,values=['Aurora','Nebula','Solar','Ocean'],state='readonly');theme.set('Aurora');theme.pack()
size=tk.Scale(root,from_=120,to=280,orient='horizontal',label='Planet size',length=330);size.set(220);size.pack(pady=12)
message=tk.Entry(root,width=42);message.insert(0,'Hello from our Linux desktop!');message.pack(pady=12)
status=tk.StringVar(value='Only these controls are sent. No desktop data is read.')
def send():
    data={'theme':theme.get(),'size':size.get(),'message':message.get()[:160],'sent':time.strftime('%H:%M:%S'),'nonce':time.time_ns()}
    tmp=BASE/'request.tmp';tmp.write_text(json.dumps(data));tmp.replace(BASE/'request.json');status.set('Sending…')
def poll():
    try: status.set((BASE/'status.txt').read_text()[:180])
    except OSError: pass
    root.after(1000,poll)
tk.Button(root,text='TRANSMIT TO ORBIT',command=send,bg='#b5f268',font=('Sans',13,'bold')).pack(pady=15)
tk.Label(root,textvariable=status,wraplength=420,bg='#10182b',fg='#eef5ff').pack()
poll();root.mainloop()
