FANTASY QUAKE

RISE OF THE PHOENIX
http://fantasy.stomped.com

Beta 0.673

Release date:
12-21-97
----------------------------
Info:
----------------------------
FQ:RotP is a semi-complete Total Conversion for the registered version of
Quake from id Software (see copyright info at bottom of text).

----------------------------

What is Fantasy Quake, what is it about?

Limitations of Notepad prevent even a slight hint as to the deep storyline
of this fantastical realm of might, magic, and mayhem.  Choose from among
six player classes (as opposed to only 4 in Hexen2) and battle your way
across the continent in search of the fabeled Phoenix Egg, a legendary 
immortal bird who is symbolic of the Balance of Life, Death, and Rebirth.  

Each character has his/her own motivations for seeking the Egg of the Phoenix,
but they all share one goal and purpose - get the helpless Egg before the
invading army, led by a supreme evil, find it.

Read the file "feature.txt" for more detailed list of features.

----------------------------

Requirements for Fantasy Quake above those needed for standard Quake:

- 16 megs system RAM is likely the bare minimum.  Standard quake uses a 8 meg heapsize
under Win95 by default, you'll need to change this to AT LEAST 12 megabytes, by 
way of the -winmem command line option, or -heapsize command line option for 
WinQuake.  (more about this later.)  RECOMMENDED - 16 megs heapsize or greater
for most variations of Quake.  (Exception: GLQuake needs 24 megs heapsize for
good performance, but should run with it's default settings.)

- about 70 megabytes free space on the harddrive containing Quake.

- Lots of free time to play the game :-)

----------------------------

Installing Fantasy Quake:

If downloading off the internet, follow instructions on the webpage, which
is basically to extract each zipfile into your Quake directory, preserving
subdirectories (-d command line option in PKUNZIP, default settings in WinZip.)

If you need more help using PKUNZIP or WinZip, refer to their documentation.

If you're pulling this off the CD, everything should be all nice and tucked
away in a self-extracting EXE file, no fuss no muss.  Just follow it's instructions
after executing the file.  When done, you should see a "fq" directory under Quake,
and various files within.

Mac users - you're on your own.  None of us has a Mac nor ever will.  I've been told
from Mac users attempting to use our conversion in the past that some levels simply
will not load, so, I have separated the maps from the prog files.  If the maps
prove unable to work on your system, you can simply delete pak1.pak and free up about
40 megs HD space.  Fantasy Quake will still be very enjoyable "overlaid" on standard
Quake maps.  (All Quake monsters are replaced, etc.)

----------------------------

Starting a game of Fantasy Quake:

Easy.  If you've used Quake patches before, then it's nothing new to you.  Merely
run Quake (and any of it's variants such as WinQuake) with the -game fq -winmem 12
command line options.  A typical command line option would appear as follows:

C:\quake>quake -game fq -winmem 20 +map fqrotpst

where

-game tells Quake where to look for the modifications;

-winmem allocates a greater heapsize.  The number after it is the amount of memory
 that you wish to give it - if you have the RAM, give it as much as you dare, but at
 LEAST 12.

+map fqrotpst tells Fantasy Quake to skip all demos (we didn't make any anyway) and 
 immediately dump you in the Fantasy Quake start map.  If you don't use this command
 line option or mistype it, you'll end up on the Quake start map.  Merely drop the 
 console (~ key) and type CHANGELEVEL FQROTPST.

**New 12-21-97 - I have a batch file (fq.bat) that will make loading FQ much easier.
Merely type FQ at the c:\quake DOS prompt.  You'll be shown a choice of options, all
self-explanatory.  Note: this batch file will not work from a Win95 desktop shortcut.
Feel free to edit this batch file with Notepad, DOS Edit, etc. to make any system-specific
changes.

Before you can use this, however, you'll need to move it from the quake/fq directory to
the root Quake directory.  If you're downloading the ZIP format archive, nevermind, I
figured a way of having the thing move itself there on it's own. (These compression
utilities are funny sometimes.)

----------------------------

Using WinQuake, GLQuake, or other variants:

Use the same info above, but replace -winmem with -heapsize 12000, (or greater,) as
this value is in kilobytes and not megabytes.  (Add three zeros to the amount of megabytes
you were shooting for is an easy way of calculating the difference.)

For GLQuake, we recommend a -heapsize 24000 or greater if you can spare it.  Default 
is 16000 without any command line option. 

----------------------------
Why does Fantasy Quake use up so much memory????

By now you see a trend - Fantasy Quake does require more memory than vanillia Quake.
The reasons are rather simple, Fantasy Quake player models are vastly more complex and
animated than the single Quake dude.  Quake has to load up 6 player models, each with over
double (maybe triple) the frames as one Quake dude.  It makes for a much better multiplayer
experience to see more about your opponents.... (see features.txt)

Also some levels precache some voice-overs, which eat up a bit more memory.

----------------------------

Finding Help:

On the web, we are at http://fantasy.stomped.com, there we have a manual, bullentin board,
FAQ, and other resources to help you out.  For you CD-ROM people, we have taken the 
liberty of including the manual in a zip file, which should be located in your quake/fq
directory.  Unzip this into an empty folder, and use your webbrowser to browse the files.
(You do not need an internet connection to view the files stored on your own harddrive you
know.) 

Once you extract the zip, open the file "manualx.html" with your webbrowser.

---------------------------
Thanks again for downloading FQ: Rotp.
We hope you'll enjoy playing it as much as we do making it.

And remember this is a beta, so there will be glitches. If you find something
that seems like a problem, first read the manual and search for answers. If
you still think you found a bug, please don't send mail, just post something
on the bug board on the site,
http://fantasy.stomped.com/bugboard.html

We need your input on gameplay too. Please don't post new ideas, or cool ideas,
or kick-ass ideas for the patch on the bugboard yet. We want to make the game
balanced with the feature already implemented. So, if you think some stuff 
is over-powered, or some character class is too weak, or some levels is too 
hard, post something about it.


PLAYING THE GAME:

well, if you're reading this, you have already unziped the files in your quake
directory.

Now to play the game, you should use this command line:

winquake -heapsize 12000 -game fq +map fqrotpst

That should take care of everything and you should start at the right place.
Heapsize 12000 is the minimum required (meaning you need at least 16 megs on your
machine). If you have more memory, you should put a higher number.

Take some time to read the manual, before you play, at least the section on the
characters classes. You wouldn't want to miss the explanation about the use
of your powers... The manual can be found at:
http://fantasy.stomped.com



ADDITIONAL INFO

You can find additional info on the site:
http://fantasy.stomped.com
Check the manual, it's worth reading.
Come back on the site often for patch update and exciting news.


CREDITS AND THANKS

-Thanks for testing and advising:
Frenzy (sjervis@telusplanet.net), Jagasian (lsimon@isource.net), 
Stalker (Ctgreats@ultranet.ca ), Dodger (jdmcniff@wolf.co.net), 
Nakedman (nakedman@telefragged.com), QuakeGod (quakegod@telefragged.com),
Mooch (dunleara@ucunix.san.uc.edu), Shiftre (shiftre@zimage.com),
N.O.Doubts (rhuian@flash.net), Maya, and lastly, the guy that worked
so hard on the new console characters, only to have me forget his name :-(

-Thanks for letting us include some of your stuff:
The coder of the awesome grappling hook,
The guys from the DarkMare project for the shield model.
Jeff Hardy for code from previous projects

-Thanks for doing funny interviews:
Flood (flood@plashcc.com) from TC Magazine, 
EmBrioNiC (emb@qa.com) and _Nuclear_ from NAWC Gold.

-Thanks to the people who wrote theses quick-ass quake tools:
Qme, MipDip, Adquedit, Graphixer, FastQCC, ProQCC 1.60, and of course
BSP - Yahn Bernier, we love you. (Invictus).

-Thanks to everyone that supported us during the fall of wot, that helped.

-Ryan Lord, thanks for giving me the kick in pants about a year ago to
 do a TC.  (Invictus)

-Additional thanks to:
Jeff "Rager" Hardy for code from previous projects
Raven for Hexen sounds, textures
Blizzard for Warcraft 2 sounds
Mordor (forgot the company name) for the backstab noise
Alias|Wavefront for making the best 3D softs on the planet

-Special thanks:
Id for Quake


-And thanks to the ones we forgot...



 

THE TEAM

Fireball        Head coder                              fireball@stomped.com

Invictus        Levels, docs, story telling, P.R        invictus@stomped.com

Shaper          Models, skins, levels, textures, gfx    shaper@stomped.com

Kew             Lots of levels                          kerrow@agt.net

Arjuna          Models, skins                           arjuna@stomped.com
                        
Roots           Additional code for monsters and AI     roots@upcworld.com




LEVELS NAMES IN ORDER (and their author)

FQROTPST        shaper
FQROTP1         kew
FQROTP2         kew
FQROTP3         shaper
FQROTP4         kew
FQROTP5         kew
FQROTP6         kew
FQROTP7         kew
FQEXTRA1        kew
FQROTP8         kew
FQROTP8A        kew
FQROTP9         shaper
FQROTP9S        shaper
FQROTP10        invictus
FQROTP11        invictus
FQROTP1S        invictus
FQROTP12        shaper
FQROTP13        shaper
FQROTP14        shaper
FQROTP15        invictus
FQFHOD          invictus

And the Deathmatch levels:

FQDM1           Shaper
FQDM2           Shaper
FQDM3           Invictus
FQDM4           Kew

Extra Maps:

They are in there.....

LEGAL STUFF

Fantasy Quake:  Rise of the Phoenix is FREE and you may play it, copy it,
give it to your friends or send it anywhere you wish, without any charge
from us.  
HOWEVER, ANY ALTERATION OF ANY PART OF THIS PROGRAM OR ITS
ACCOMPANYING MAP LEVELS MAY NOT BE DONE.  IN ADDITION, ANY COPY OR
DISTRIBUTION OF THIS PROGRAM AND/OR THE MAP LEVELS WITH IT, MUST ALWAYS
BE ACCOMPANIED BY THIS README FILE IN ITS ENTIRETY.   
* NO CHARGE OR FEE MAY BE MADE OR LEVIED ON ANY DISTRIBUTION OF THIS 
 PROGRAM OR ANY PART OF IT.*

Any reproduction on compact disc will be permitted ONLY with our prior
written permission.

 In other words, enjoy it but don't steal it.

 Team Phoenix

"QUAKE(r) is a registered trademark of Id Software, Inc. QUAKE(r), the stylized
 reproduction of the QUAKE(r) trademark, including, without limitation, the Q in
 QUAKE(r), and the images depicted in QUAKE(r) are the copyrighted property of 
Id Software, Inc." 
