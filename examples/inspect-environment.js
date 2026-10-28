// Run in the page's DevTools Console. This only reads browser properties.
(async () => {
    const hints = navigator.userAgentData;
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: Array.from(navigator.languages),
        webdriver: navigator.webdriver,
        screen: {width: screen.width, height: screen.height,
            availWidth: screen.availWidth, availHeight: screen.availHeight},
        window: {outerWidth, outerHeight, innerWidth, innerHeight},
        devicePixelRatio,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        clientHints: hints ? hints.toJSON() : null,
        highEntropyHints: hints ? await hints.getHighEntropyValues(
            ['architecture', 'bitness', 'platformVersion', 'fullVersionList']) : null,
    };
})();
