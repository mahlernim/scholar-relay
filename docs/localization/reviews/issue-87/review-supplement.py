"""Repeat the frozen independent count-label proposals in a new output directory."""
from provider_runner import main

if __name__ == "__main__":
    main("supplement-prompt.txt", "-supplement", 600)
