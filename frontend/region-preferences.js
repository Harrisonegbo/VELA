(() => {
  const currencyCacheKey = 'velaCurrencyRates';
  const currencyCacheMaxAge = 6 * 60 * 60 * 1000;

  function localeForMarket(language, country) {
    const languageLocale = languageLocaleMap[language] || 'en';
    try {
      return new Intl.Locale(languageLocale, { region: country }).toString();
    } catch (error) {
      console.warn('Could not construct a market locale; using the language and country codes.', error);
      return `${languageLocale.split('-')[0]}-${country}`;
    }
  }

  function marketName(country, locale) {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' }).of(country) || country;
    } catch (error) {
      console.warn('Could not localize the selected country name.', error);
      return countries.find(item => item.code === country)?.name || country;
    }
  }

  function validCurrencyData(data, country) {
    return Boolean(
      data &&
      data.country === country &&
      /^[A-Z]{3}$/.test(data.currency || '') &&
      data.rates &&
      Number.isFinite(data.rates.USD) &&
      data.rates.USD > 0 &&
      Number.isFinite(data.rates[data.currency]) &&
      data.rates[data.currency] > 0
    );
  }

  function readCachedCurrencyData(country) {
    try {
      const cached = JSON.parse(localStorage.getItem(currencyCacheKey) || 'null');
      return validCurrencyData(cached, country) && Number.isFinite(cached.savedAt)
        ? cached
        : null;
    } catch (error) {
      console.warn('Could not read cached regional currency data.', error);
      return null;
    }
  }

  refreshLocalePreferences = async function () {
    const requestId = ++localeRequestId;
    const country = selectedCountry;
    const language = selectedLanguage;
    const locale = localeForMarket(language, country);
    selectedLocale = locale;
    document.documentElement.lang = languageLocaleMap[language] || 'en';

    const name = marketName(country, locale);
    const location = $('.location');
    const settingLocation = $('#settingLocation');
    const countryButton = $('#countryPicker');
    if (location) location.textContent = name;
    if (settingLocation) settingLocation.value = name;
    if (countryButton) {
      countryButton.textContent = country;
      countryButton.title = `Country and language: ${name} · ${language}`;
      countryButton.setAttribute('aria-label', `Country and language: ${name} · ${language}`);
    }

    const status = $('#localeStatus');
    if (status) status.textContent = `Updating regional settings for ${name} · ${language}…`;

    const cached = readCachedCurrencyData(country);
    let rateData = cached && Date.now() - cached.savedAt < currencyCacheMaxAge ? cached : null;
    let rateSource = rateData ? 'saved' : 'live';
    let liveError = null;

    if (!rateData) {
      try {
        const response = await pwApi(`/api/currency/${encodeURIComponent(country)}`);
        if (!validCurrencyData(response, country)) {
          throw new Error('The backend returned currency data for a different market or an invalid rate.');
        }
        rateData = { ...response, savedAt: Date.now() };
        try {
          localStorage.setItem(currencyCacheKey, JSON.stringify(rateData));
        } catch (error) {
          console.warn('Could not cache regional currency data.', error);
        }
      } catch (error) {
        liveError = error;
        if (cached) {
          rateData = cached;
          rateSource = 'stale';
        }
      }
    }

    if (requestId !== localeRequestId) return;

    if (rateData) {
      selectedCurrency = rateData.currency;
      exchangeRates = rateData.rates;
      const updated = rateData.updated_at || new Date(rateData.savedAt).toLocaleString(locale);
      const freshness = rateSource === 'stale'
        ? `using saved rates (${updated}); live refresh failed`
        : `exchange rates updated ${updated}`;
      status.textContent = `${name} · ${language} · ${selectedCurrency} · ${freshness}.`;
    } else {
      selectedCurrency = null;
      exchangeRates = {};
      status.textContent = `${name} · ${language} · Currency conversion is unavailable; amounts are shown in their recorded currencies.${liveError ? ` ${liveError.message}` : ''}`;
    }

    renderAll();
    try {
      await localizeDashboard();
    } catch (error) {
      if (requestId === localeRequestId && status) {
        status.textContent += ` Translation unavailable; some dashboard text remains in English. ${error.message}`;
      }
    }
  };

  saveCountryPreferences = function () {
    const country = $('#countryChoice').value;
    const language = $('#languageChoice').value;
    if (!countries.some(item => item.code === country) || !languagesForCountry(country).includes(language)) {
      toast('Choose a valid country and language.');
      return;
    }

    selectedCountry = country;
    selectedLanguage = language;
    selectedLocale = localeForMarket(language, country);
    localStorage.setItem('velaCountry', country);
    localStorage.setItem('velaLanguage', language);
    closeModal();
    refreshLocalePreferences();
    toast(`Market set to ${marketName(country, selectedLocale)} · ${language}.`);
  };
})();
