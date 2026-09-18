@echo off
rem RuninqVic lecture setup: opens a small window to register the ElevenLabs key / lecture code on Vercel (no terminal typing needed).
start "" powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0tools\lecture-setup.ps1"
